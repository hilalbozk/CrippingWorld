const submissionEndpoint = document.querySelector('meta[name="submission-endpoint"]').content.trim();
const contributionForm = document.getElementById('contributionForm');
const gameInputs = Array.from(contributionForm.querySelectorAll('input[name="game"]'));
const submitButton = document.getElementById('submit');
const uploads = document.getElementById('uploads');
const formStatus = document.getElementById('formStatus');
const fileNote = document.getElementById('fileNote');
const uploadLimits = fileNote.textContent;
const whoForm = document.getElementById('whoForm');
const whoUpload = document.getElementById('whoCardFile');
const whoSubmit = document.getElementById('submitWho');
const whoStatus = document.getElementById('whoFormStatus');
const whoName = document.getElementById('whoName');
const whoFields = {
  description: document.getElementById('whoDescribe'),
  location: document.getElementById('whoWhere'),
  everyday_spaces: document.getElementById('whoSpaces'),
  context: document.getElementById('whoContext')
};
const megabyte = 1024 ** 2;
const supportedFile = /\.(pdf|jpg|jpeg|png|gif|webp|heic|heif|mp3|m4a|aac|wav|ogg|opus|webm|flac|txt|doc|docx)$/i;

if (submissionEndpoint) {
  submitButton.disabled = false;
  submitButton.textContent = 'Submit contribution';
  document.getElementById('whoAvailability').textContent =
    'Your answers and any attached file will go to the study team’s sciebo storage when you submit.';
}

uploads.addEventListener('change', () => {
  const count = uploads.files.length;
  fileNote.textContent = count ? `${count} selected. ${uploadLimits}` : uploadLimits;
});

function encodeFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve({
      name: file.name,
      data: reader.result.slice(reader.result.indexOf(',') + 1)
    }));
    reader.addEventListener('error', () => reject(new Error('A file could not be read.')));
    reader.readAsDataURL(file);
  });
}

async function sendSubmission({ form, status, endpoint, submission, files, maxFiles, limits }) {
  if (files.length > maxFiles || files.some(file => !file.size || file.size > 10 * megabyte) ||
      files.reduce((total, file) => total + file.size, 0) > 20 * megabyte) {
    status.textContent = `Choose nonempty files. ${limits}`;
    return;
  }
  if (files.some(file => !supportedFile.test(file.name))) {
    status.textContent = 'Choose a supported image, audio file, PDF, text file or Word document.';
    return;
  }

  form.setAttribute('aria-busy', 'true');
  const controls = Array.from(form.elements);
  controls.forEach(control => { control.disabled = true; });
  status.textContent = 'Sending your contribution…';

  try {
    submission.files = await Promise.all(files.map(encodeFile));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      body: JSON.stringify(submission)
    });
    const result = await response.json();
    if (response.status !== 201 || typeof result.id !== 'string' || !/^[a-f0-9]{32}$/.test(result.id)) {
      throw new Error('The upload was not confirmed.');
    }
    form.reset();
    status.textContent = `Contribution received. Your receipt ID is ${result.id}.`;
  } catch {
    status.textContent = 'We could not confirm your submission. Your entries are still here. If the problem continues, contact the researcher.';
  } finally {
    controls.forEach(control => { control.disabled = false; });
    form.removeAttribute('aria-busy');
  }
}

contributionForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!submissionEndpoint || contributionForm.hasAttribute('aria-busy')) return;

  const games = gameInputs.filter(input => input.checked).map(input => input.value);
  if (!games.length) {
    formStatus.textContent = 'Select at least one game before submitting.';
    gameInputs[0].focus();
    return;
  }

  const files = Array.from(uploads.files);
  const reflection = document.getElementById('reflection').value.trim();
  if (!reflection && !files.length) {
    formStatus.textContent = 'Add a reflection or a file before submitting.';
    return;
  }

  await sendSubmission({
    form: contributionForm,
    status: formStatus,
    endpoint: submissionEndpoint,
    submission: {
      chosen: document.getElementById('chosen').value,
      game: games,
      reflection,
      consentAcknowledged: document.getElementById('consent').checked,
      considerThesisReproduction: document.getElementById('reproduce').checked
    },
    files,
    maxFiles: 5,
    limits: uploadLimits
  });
  uploads.dispatchEvent(new Event('change'));
});

function updateWhoSubmit() {
  const hasContent = whoUpload.files.length || [whoName, ...Object.values(whoFields)]
    .some(field => field.value.trim());
  whoSubmit.disabled = !submissionEndpoint || !hasContent || whoForm.hasAttribute('aria-busy');
}

whoForm.addEventListener('input', updateWhoSubmit);
whoUpload.addEventListener('change', updateWhoSubmit);
updateWhoSubmit();

whoForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (whoSubmit.disabled) return;

  await sendSubmission({
    form: whoForm,
    status: whoStatus,
    endpoint: `${submissionEndpoint}/who-am-i`,
    submission: {
      chosen: whoName.value.trim(),
      game: '',
      reflection: '',
      consentAcknowledged: document.getElementById('whoConsent').checked,
      considerThesisReproduction: document.getElementById('whoReproduce').checked,
      whoAmI: Object.fromEntries(Object.entries(whoFields).map(([key, field]) => [key, field.value.trim()]))
    },
    files: Array.from(whoUpload.files),
    maxFiles: 1,
    limits: document.getElementById('whoFileNote').textContent
  });
  updateWhoSubmit();
});
