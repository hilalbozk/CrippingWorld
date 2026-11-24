const submissionEndpoint = document.querySelector('meta[name="submission-endpoint"]').content.trim();
const contributionForm = document.getElementById('contributionForm');
const submitButton = document.getElementById('submit');
const uploads = document.getElementById('uploads');
const formStatus = document.getElementById('formStatus');
const fileNote = document.getElementById('fileNote');
const uploadLimits = fileNote.textContent;
const megabyte = 1024 ** 2;
const supportedFile = /\.(pdf|jpg|jpeg|png|gif|webp|heic|heif|mp3|m4a|aac|wav|ogg|opus|webm|flac|txt|doc|docx)$/i;

if (submissionEndpoint) {
  submitButton.disabled = false;
  submitButton.textContent = 'Submit contribution';
  document.getElementById('submissionAvailability').textContent =
    'Your contribution will be sent to the study team’s sciebo storage when you submit it.';
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

contributionForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!submissionEndpoint || contributionForm.hasAttribute('aria-busy')) return;

  const files = Array.from(uploads.files);
  const reflection = document.getElementById('reflection').value.trim();
  if (!reflection && !files.length) {
    formStatus.textContent = 'Add a reflection or a file before submitting.';
    return;
  }
  if (files.length > 5 || files.some(file => !file.size || file.size > 10 * megabyte) ||
      files.reduce((total, file) => total + file.size, 0) > 20 * megabyte) {
    formStatus.textContent = `Choose nonempty files. ${uploadLimits}`;
    return;
  }
  if (files.some(file => !supportedFile.test(file.name))) {
    formStatus.textContent = 'Choose a supported image, audio file, PDF, text file or Word document.';
    return;
  }

  const submission = {
    chosen: document.getElementById('chosen').value,
    game: document.getElementById('gameSelect').value,
    reflection,
    consentAcknowledged: document.getElementById('consent').checked,
    considerThesisReproduction: document.getElementById('reproduce').checked
  };
  contributionForm.setAttribute('aria-busy', 'true');
  const controls = Array.from(contributionForm.elements);
  controls.forEach(control => { control.disabled = true; });
  formStatus.textContent = 'Sending your contribution…';

  try {
    submission.files = await Promise.all(files.map(encodeFile));
    const response = await fetch(submissionEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      body: JSON.stringify(submission)
    });
    const result = await response.json();
    if (response.status !== 201 || !/^[a-f0-9]{32}$/.test(result.id)) {
      throw new Error('The upload was not confirmed.');
    }
    contributionForm.reset();
    uploads.dispatchEvent(new Event('change'));
    formStatus.textContent = `Contribution received. Your receipt ID is ${result.id}.`;
  } catch {
    formStatus.textContent = 'We could not confirm your submission. Your entries are still here. If the problem continues, contact the researcher.';
  } finally {
    controls.forEach(control => { control.disabled = false; });
    contributionForm.removeAttribute('aria-busy');
  }
});
