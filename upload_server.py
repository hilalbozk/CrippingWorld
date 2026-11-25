"""WSGI endpoint for the Cripping Space contribution form."""

import base64
import binascii
import io
import json
import os
import re
import uuid
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.client import HTTPException
from pathlib import PurePath
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


MAX_FILES = 5
MAX_FILE_BYTES = 10 * 1024**2
MAX_TOTAL_BYTES = 20 * 1024**2
MAX_REQUEST_BYTES = 4 * ((MAX_TOTAL_BYTES + 2) // 3) + 128 * 1024
ALLOWED_EXTENSIONS = {
    ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif",
    ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".webm", ".flac",
    ".txt", ".doc", ".docx",
}


class InvalidSubmission(ValueError):
    pass


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def text_field(data, key, limit):
    value = data.get(key, "")
    if not isinstance(value, str) or len(value) > limit:
        raise InvalidSubmission(f"The {key} field is invalid or too long.")
    return value.strip()


def archive_submission(payload, receipt, *, who_am_i=False):
    if not isinstance(payload, dict):
        raise InvalidSubmission("Invalid submission.")
    chosen = text_field(payload, "chosen", 200)
    reflection = text_field(payload, "reflection", 10000)
    game = text_field(payload, "game", 2)
    if game and game not in {f"{number:02}" for number in range(1, 9)}:
        raise InvalidSubmission("Choose a game from the list.")
    if payload.get("consentAcknowledged") is not True:
        raise InvalidSubmission("Please acknowledge the participation statement.")
    reproduce = payload.get("considerThesisReproduction")
    if not isinstance(reproduce, bool):
        raise InvalidSubmission("Invalid thesis reproduction preference.")
    uploads = payload.get("files", [])
    if not isinstance(uploads, list) or len(uploads) > MAX_FILES:
        raise InvalidSubmission(f"Choose up to {MAX_FILES} files.")
    who_answers = None
    if who_am_i:
        answers = payload.get("whoAmI")
        if not isinstance(answers, dict):
            raise InvalidSubmission("Invalid Who Am I answers.")
        who_answers = {
            "description": text_field(answers, "description", 10000),
            "location": text_field(answers, "location", 1000),
            "everyday_spaces": text_field(answers, "everyday_spaces", 10000),
            "context": text_field(answers, "context", 10000),
        }
        if len(uploads) > 1:
            raise InvalidSubmission("Choose one Who Am I attachment.")
        if not (chosen or any(who_answers.values()) or uploads):
            raise InvalidSubmission("Add an answer or a file.")
    elif not (reflection or uploads):
        raise InvalidSubmission("Add a reflection or a file.")

    archive = io.BytesIO()
    files = []
    total_bytes = 0
    with zipfile.ZipFile(archive, "w") as bundle:
        for number, item in enumerate(uploads, start=1):
            if not isinstance(item, dict):
                raise InvalidSubmission("Invalid attachment.")
            name = text_field(item, "name", 255)
            extension = PurePath(name).suffix.lower()
            if extension not in ALLOWED_EXTENSIONS:
                raise InvalidSubmission("Choose a supported image, audio or document format.")
            encoded = item.get("data")
            if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_FILE_BYTES + 2) // 3):
                raise InvalidSubmission("Each attachment must be 10 MB or smaller.")
            try:
                contents = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError):
                raise InvalidSubmission("An attachment could not be read.") from None
            total_bytes += len(contents)
            if not contents or len(contents) > MAX_FILE_BYTES or total_bytes > MAX_TOTAL_BYTES:
                raise InvalidSubmission("Files must be nonempty and no more than 20 MB combined.")
            # Use server-generated paths. The original filenames appear only in the manifest.
            path = f"attachments/{number:02}{extension}"
            bundle.writestr(path, contents)
            files.append({"name": name, "path": path})

        manifest = {
            "id": receipt,
            "received_at": datetime.now(timezone.utc).isoformat(),
            "chosen_name_or_code": chosen,
            "game": game,
            "reflection": reflection,
            "participation_statement_acknowledged": True,
            "would_consider_thesis_reproduction": reproduce,
            "attachments": files,
        }
        if who_answers is not None:
            manifest["who_am_i"] = who_answers
        bundle.writestr("submission.json", json.dumps(manifest, ensure_ascii=True, indent=2))
    return archive.getvalue()


def sciebo_target():
    url = os.environ.get("SCIEBO_WEBDAV_URL", "").rstrip("/")
    token = os.environ.get("SCIEBO_SHARE_TOKEN", "")
    password = os.environ.get("SCIEBO_SHARE_PASSWORD", "")
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not (parsed.hostname or "").endswith(".sciebo.de")
        or parsed.path != "/public.php/webdav"
        or parsed.username or parsed.password or parsed.query or parsed.fragment
        or not re.fullmatch(r"[a-zA-Z0-9]+", token)
        or not password
    ):
        raise ValueError("Invalid sciebo File Drop configuration.")
    return url, token, password


def send_to_sciebo(target, receipt, archive):
    url, token, password = target
    # File Drop writes use Nextcloud's public DAV route.
    url = f"{url.removesuffix('/public.php/webdav')}/public.php/dav/files/{token}"
    auth = base64.b64encode(f"{token}:{password}".encode()).decode("ascii")
    request = Request(f"{url}/{receipt}.zip", data=archive, method="PUT", headers={
        "Authorization": f"Basic {auth}",
        "Content-Type": "application/zip",
        "If-None-Match": "*",
        "X-Requested-With": "XMLHttpRequest",
    })
    with build_opener(NoRedirects()).open(request, timeout=60) as response:
        if response.status not in {200, 201, 204}:
            raise OSError("Unconfirmed sciebo upload.")


def application(environ, start_response):
    origin = environ.get("HTTP_ORIGIN")
    allowed = os.environ.get("UPLOAD_ORIGIN")
    headers = [("Cache-Control", "no-store"), ("Vary", "Origin")]
    if allowed and origin == allowed:
        headers.append(("Access-Control-Allow-Origin", allowed))

    def reply(status_code, **payload):
        body = json.dumps(payload).encode() if payload else b""
        response_headers = headers.copy()
        if body:
            response_headers.extend([
                ("Content-Type", "application/json"),
                ("Content-Length", str(len(body))),
            ])
        start_response(f"{status_code} {HTTPStatus(status_code).phrase}", response_headers)
        return [body]

    path = environ.get("PATH_INFO")
    method = environ.get("REQUEST_METHOD")
    if path == "/healthz" and method == "GET":
        return reply(200, status="ok")
    # Keep older deployments from accepting a Who Am I card without its answers.
    who_am_i = path == "/submissions/who-am-i"
    if path != "/submissions" and not who_am_i:
        return reply(404, error="Endpoint not found.")
    if not allowed or origin != allowed:
        return reply(403, error="This website is not configured for uploads.")
    if method == "OPTIONS":
        headers.extend([
            ("Access-Control-Allow-Methods", "POST"),
            ("Access-Control-Allow-Headers", "Content-Type"),
        ])
        return reply(204)
    if method != "POST":
        return reply(405, error="Use POST to submit a contribution.")
    if environ.get("CONTENT_TYPE", "").split(";", 1)[0] != "application/json":
        return reply(415, error="Unsupported submission format.")

    try:
        length = int(environ.get("CONTENT_LENGTH") or "0")
    except ValueError:
        return reply(400, error="Invalid request size.")
    if not 0 < length <= MAX_REQUEST_BYTES:
        return reply(413, error="The submission is empty or too large.")

    try:
        target = sciebo_target()
    except ValueError:
        return reply(503, error="The upload service has not been configured.")
    receipt = uuid.uuid4().hex
    try:
        payload = json.loads(environ["wsgi.input"].read(length))
        archive = archive_submission(payload, receipt, who_am_i=who_am_i)
    except InvalidSubmission as error:
        return reply(400, error=str(error))
    except (ValueError, RecursionError):
        return reply(400, error="The submission could not be read.")

    try:
        send_to_sciebo(target, receipt, archive)
    except (OSError, HTTPException):
        return reply(502, error="Sciebo did not confirm the upload.")
    return reply(201, id=receipt)
