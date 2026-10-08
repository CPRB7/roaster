(() => {
  const REACTIONS = ['shit', 'mid', 'respect'];
  const REACTION_COPY = {
    shit: { label: 'SH*T', message: 'Brutal. Your vote is in.' },
    mid: { label: 'NOT-SH*T', message: 'A fair-ish verdict. Logged.' },
    respect: { label: 'RESPECT++', message: 'Respect logged. You are a good person.' },
  };
  let liveData = null;
  let authStatus = { loginRequired: false, googleEnabled: false, user: null };
  let authMode = 'login';
  let toastHandle;
  let image = null;
  let imageUrl = null;
  let rectangles = [];
  let drawing = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const toast = $('#toast');
  const cursorLight = $('.cursor-light');

  if (cursorLight && matchMedia('(hover: hover) and (pointer: fine)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.addEventListener('pointermove', (event) => {
      document.documentElement.style.setProperty('--pointer-x', `${event.clientX}px`);
      document.documentElement.style.setProperty('--pointer-y', `${event.clientY}px`);
      cursorLight.classList.add('is-active');
    });
    window.addEventListener('pointerleave', () => cursorLight.classList.remove('is-active'));
  }

  function setupNetworkBackground() {
    const canvas = $('.network-web');
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hasMouse = matchMedia('(hover: hover) and (pointer: fine)').matches && !reducedMotion;
    const pointer = { x: -1000, y: -1000 };
    let width = 0;
    let height = 0;
    let nodes = [];

    function resize() {
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      const count = Math.min(64, Math.max(28, Math.round(width * height / 15000)));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: reducedMotion ? 0 : (Math.random() - 0.5) * 0.22,
        vy: reducedMotion ? 0 : (Math.random() - 0.5) * 0.22,
        color: Math.random() > 0.76 ? '255, 105, 36' : Math.random() > 0.5 ? '222, 112, 255' : '231, 229, 255',
      }));
      draw();
    }

    function draw() {
      context.clearRect(0, 0, width, height);
      const reach = Math.min(185, Math.max(135, width / 6.5));

      nodes.forEach((node, index) => {
        if (!reducedMotion) {
          node.x += node.vx;
          node.y += node.vy;
          if (node.x < 0 || node.x > width) node.vx *= -1;
          if (node.y < 0 || node.y > height) node.vy *= -1;
        }

        for (let otherIndex = index + 1; otherIndex < nodes.length; otherIndex += 1) {
          const other = nodes[otherIndex];
          const distance = Math.hypot(node.x - other.x, node.y - other.y);
          if (distance >= reach) continue;
          context.strokeStyle = `rgba(178, 82, 220, ${(1 - distance / reach) * 0.4})`;
          context.shadowBlur = 6;
          context.shadowColor = 'rgba(178, 82, 220, 0.7)';
          context.lineWidth = 1;
          context.beginPath();
          context.moveTo(node.x, node.y);
          context.lineTo(other.x, other.y);
          context.stroke();
          context.shadowBlur = 0;
        }

        if (hasMouse) {
          const distance = Math.hypot(node.x - pointer.x, node.y - pointer.y);
          if (distance < reach * 1.3) {
            context.strokeStyle = `rgba(255, 76, 145, ${(1 - distance / (reach * 1.3)) * 0.52})`;
            context.shadowBlur = 7;
            context.shadowColor = 'rgba(255, 76, 145, 0.75)';
            context.beginPath();
            context.moveTo(node.x, node.y);
            context.lineTo(pointer.x, pointer.y);
            context.stroke();
            context.shadowBlur = 0;
          }
        }

        context.fillStyle = `rgba(${node.color}, 0.85)`;
        context.shadowBlur = 5;
        context.shadowColor = `rgba(${node.color}, 0.7)`;
        context.beginPath();
        context.arc(node.x, node.y, 2, 0, Math.PI * 2);
        context.fill();
        context.shadowBlur = 0;
      });

      if (!reducedMotion) requestAnimationFrame(draw);
    }

    if (hasMouse) {
      window.addEventListener('pointermove', (event) => {
        pointer.x = event.clientX;
        pointer.y = event.clientY;
      });
      window.addEventListener('pointerleave', () => { pointer.x = -1000; pointer.y = -1000; });
    }
    window.addEventListener('resize', resize);
    resize();
  }

  setupNetworkBackground();

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastHandle);
    toastHandle = setTimeout(() => toast.classList.remove('show'), 2700);
  }

  async function apiRequest(url, options = {}) {
    const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (result.code === 'AUTH_REQUIRED') showAuthDialog();
      throw new Error(result.error || 'The request could not be completed.');
    }
    return result;
  }

  function updateAuthControls() {
    const button = $('#auth-button');
    const userLabel = $('#auth-user');
    $('#auth-google').hidden = !authStatus.googleEnabled;
    button.hidden = !authStatus.loginRequired && !authStatus.user;
    $('#login-fact').textContent = authStatus.loginRequired ? 'LOGIN REQUIRED' : 'NO LOGIN';
    $('#login-fact-detail').textContent = authStatus.loginRequired
      ? 'required to upload, react & report'
      : 'sign-in stays hidden unless needed';
    button.textContent = authStatus.user ? 'Sign out' : 'Sign in';
    userLabel.hidden = !authStatus.user;
    userLabel.textContent = authStatus.user?.email || '';
    $('#auth-copy').textContent = authStatus.loginRequired
      ? 'Sign in is required to upload, react, or report.'
      : 'Sign in is optional now. Signed-in accounts can upload once every 30 days.';
  }

  function showAuthDialog(mode = 'login') {
    authMode = mode;
    $('#auth-title').textContent = mode === 'register' ? 'Create an account' : 'Sign in';
    $('#auth-submit').textContent = mode === 'register' ? 'Create account' : 'Sign in';
    $('#auth-mode-toggle').textContent = mode === 'register' ? 'Already have an account? Sign in' : 'Create an account';
    $('#auth-copy').textContent = mode === 'register'
      ? 'Email/password accounts do not have email verification or password recovery yet. Google sign-in requires owner configuration.'
      : 'Sign in is required to upload, react, or report.';
    $('#auth-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    $('#auth-error').textContent = '';
    if (!$('#auth-dialog').open) $('#auth-dialog').showModal();
  }

  async function refreshAuthStatus() {
    try {
      authStatus = await apiRequest('/api/auth/status');
      updateAuthControls();
      renderLive();
    } catch (error) {
      console.error('Could not load account status:', error);
    }
  }

  async function refreshLive() {
    try {
      liveData = await apiRequest('/api/live');
      renderLive();
    } catch (error) {
      console.error('Could not load live resume:', error);
      $('#vote-prompt').textContent = 'Could not load the live resume. Retrying shortly.';
    }
  }

  function showView(name, updateHash = true) {
    const upload = name === 'upload';
    $('#live-view').hidden = upload;
    $('#upload-view').hidden = !upload;
    $('#live-view').classList.toggle('active', !upload);
    $('#upload-view').classList.toggle('active', upload);
    if (updateHash) history.replaceState(null, '', upload ? '#upload' : '#live');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function getPercentages(counts) {
    const total = REACTIONS.reduce((sum, key) => sum + counts[key], 0);
    if (!total) return { shit: 0, mid: 0, respect: 0 };
    return Object.fromEntries(REACTIONS.map((key) => [key, Math.round((counts[key] / total) * 100)]));
  }

  function renderResults(counts) {
    const total = counts.total;
    const percentages = getPercentages(counts);
    const entries = [
      ['shit', 'SH*T'],
      ['mid', 'NOT-SH*T'],
      ['respect', 'RESPECT++'],
    ];
    $('#vote-total').textContent = `${total.toLocaleString()} votes`;
    $('#bar-stack').innerHTML = entries.map(([key, label]) => `
      <div class="bar-row">
        <span class="bar-name">${label}</span>
        <span class="bar-track"><span class="bar-fill ${key}" style="width:${percentages[key]}%"></span></span>
        <span class="bar-pct">${percentages[key]}%</span>
      </div>`).join('');
  }

  function renderLive() {
    const resume = liveData?.resume;
    const hasResume = Boolean(resume);
    const image = $('#live-resume-image');
    $('.live-layout').hidden = !hasResume;
    $('.idle-cta').hidden = hasResume;
    $('.resume-paper').classList.toggle('has-live', hasResume);
    if (!hasResume) {
      image.hidden = true;
      $('#countdown').textContent = '--:--:--';
      $('#live-label').textContent = 'WAITING FOR NEXT RESUME';
      $('#vote-prompt').textContent = liveData?.queued ? 'Next resume is waiting in the queue.' : 'No resume is live right now. Be the next brave soul.';
      $('#results').classList.add('hidden');
      $('.idle-cta h2').innerHTML = liveData?.queued
        ? 'The next brave soul is<br><span>in the queue.</span>'
        : 'Nobody’s brave enough right now.<br><span>Feeling reckless?</span>';
      return;
    }

    image.src = `/api/live/image?resume=${encodeURIComponent(resume.id)}`;
    image.hidden = false;
    $$('.resume-paper > :not(#live-resume-image)').forEach((element) => { element.hidden = true; });
    $('.resume-paper').setAttribute('aria-label', 'Redacted resume currently open for reactions');
    $('#live-label').textContent = resume.label || 'Anonymous resume';

    const remaining = Math.max(0, resume.expiresAt - Date.now());
    const seconds = Math.floor(remaining / 1000);
    const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    const secs = String(seconds % 60).padStart(2, '0');
    $('#countdown').textContent = `${hours}:${minutes}:${secs}`;

    $$('.reaction').forEach((button) => {
      const selected = button.dataset.reaction === resume.viewerReaction;
      button.disabled = Boolean(resume.viewerReaction) || remaining <= 0;
      button.classList.toggle('voted', selected);
      button.querySelector('.reaction-arrow').setAttribute('aria-label', selected ? 'Your vote' : 'Vote');
    });
    $('#vote-message').textContent = resume.viewerReaction
      ? REACTION_COPY[resume.viewerReaction].message
      : '';
    $('#vote-lock-note').textContent = resume.viewerReaction
      ? '✓ Your vote is locked for this resume.'
      : `↳ One vote per ${authStatus.user || authStatus.loginRequired ? 'account' : 'browser'}. Counts unlock in the final 30 minutes.`;
    $('#vote-prompt').textContent = authStatus.loginRequired && !authStatus.user
      ? 'Sign in to react or report. Counts unlock in the final 30 minutes.'
      : resume.resultsVisible
        ? 'Verdict unlocked. The group chat has spoken.'
        : 'Pick a lane. The numbers unlock in the final 30 minutes.';
    $('#report-button').disabled = Boolean(resume.reported);
    $('#report-button').textContent = resume.reported ? '✓ Already reported' : '⚑ Report this one';

    if (resume.resultsVisible && resume.counts) {
      $('#results').classList.remove('hidden');
      renderResults(resume.counts);
    } else {
      $('#results').classList.add('hidden');
    }
  }

  function renderCountdown() {
    if (!liveData?.resume) return;
    renderLive();
  }

  async function vote(reaction) {
    if (!REACTIONS.includes(reaction) || !liveData?.resume || liveData.resume.viewerReaction) return;
    $$('.reaction').forEach((button) => { button.disabled = true; });
    try {
      const result = await apiRequest('/api/votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reaction }),
      });
      liveData.resume = result.resume;
      renderLive();
      showToast(REACTION_COPY[reaction].message);
    } catch (error) {
      showToast(error.message);
      await refreshLive();
    }
  }

  function updateStepTrack(step) {
    const stages = ['dare', 'pick', 'redact', 'checklist', 'details', 'perks', 'done'];
    const position = Math.max(0, stages.indexOf(step));
    const progress = Math.min(3, Math.floor(position / 2));
    $$('.step-dot').forEach((dot, index) => {
      dot.classList.toggle('current', index === progress);
      dot.classList.toggle('passed', index < progress);
    });
  }

  function showStep(name) {
    const target = $(`[data-step="${name}"]`);
    if (!target) return;
    $$('.wizard-step').forEach((step) => step.classList.toggle('active', step === target));
    updateStepTrack(name);
    if (name === 'checklist') drawPreview($('#preview-canvas'));
    if (name === 'done') drawPreview($('#done-canvas'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function scaleDimensions(source, maxWidth = 1000, maxHeight = 1400) {
    const ratio = Math.min(1, maxWidth / source.width, maxHeight / source.height);
    return { width: Math.max(1, Math.round(source.width * ratio)), height: Math.max(1, Math.round(source.height * ratio)) };
  }

  function paintCanvas(canvas, showCurrent = false) {
    if (!canvas || !image) return;
    const context = canvas.getContext('2d');
    canvas.width = image.width;
    canvas.height = image.height;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    context.fillStyle = '#080808';
    rectangles.forEach(({ x, y, width, height }) => context.fillRect(x, y, width, height));
    if (showCurrent && drawing) {
      context.fillRect(drawing.x, drawing.y, drawing.width, drawing.height);
    }
  }

  function drawPreview(canvas) {
    if (!canvas || !image) return;
    const dimensions = scaleDimensions(image, 460, 650);
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
    context.fillStyle = '#080808';
    rectangles.forEach((rect) => context.fillRect(
      rect.x * dimensions.width / image.width,
      rect.y * dimensions.height / image.height,
      rect.width * dimensions.width / image.width,
      rect.height * dimensions.height / image.height,
    ));
  }

  function loadImageFile(file) {
    const error = $('#file-error');
    error.textContent = '';
    if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      error.textContent = 'That file type will not work here. Pick a PNG, JPG or WebP.';
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      error.textContent = 'That image is over 12 MB. Try a smaller export.';
      return;
    }
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = URL.createObjectURL(file);
    const nextImage = new Image();
    nextImage.onload = () => {
      const dimensions = scaleDimensions(nextImage);
      const flattened = document.createElement('canvas');
      flattened.width = dimensions.width;
      flattened.height = dimensions.height;
      flattened.getContext('2d').drawImage(nextImage, 0, 0, dimensions.width, dimensions.height);
      image = new Image();
      image.onload = () => {
        rectangles = [];
        $('#canvas-filename').textContent = file.name.toUpperCase().slice(0, 34);
        paintCanvas($('#redact-canvas'));
        showStep('redact');
      };
      image.src = flattened.toDataURL('image/jpeg', 0.92);
    };
    nextImage.onerror = () => { error.textContent = 'Could not open that image. Try a screenshot instead.'; };
    nextImage.src = imageUrl;
  }

  function canvasPoint(event, canvas) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) * canvas.width / bounds.width)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) * canvas.height / bounds.height)),
    };
  }

  function beginRedaction(event) {
    const canvas = event.currentTarget;
    if (!image) return;
    canvas.setPointerCapture(event.pointerId);
    const point = canvasPoint(event, canvas);
    drawing = { startX: point.x, startY: point.y, x: point.x, y: point.y, width: 0, height: 0 };
  }

  function moveRedaction(event) {
    if (!drawing) return;
    const point = canvasPoint(event, event.currentTarget);
    drawing.x = Math.min(drawing.startX, point.x);
    drawing.y = Math.min(drawing.startY, point.y);
    drawing.width = Math.abs(point.x - drawing.startX);
    drawing.height = Math.abs(point.y - drawing.startY);
    paintCanvas(event.currentTarget, true);
  }

  function endRedaction(event) {
    if (!drawing) return;
    if (drawing.width > 3 && drawing.height > 3) rectangles.push({ ...drawing });
    drawing = null;
    paintCanvas(event.currentTarget);
  }

  // View navigation and wizard controls.
  document.addEventListener('click', (event) => {
    const viewControl = event.target.closest('[data-view]');
    if (viewControl) {
      event.preventDefault();
      showView(viewControl.dataset.view);
      return;
    }
    const next = event.target.closest('[data-next]');
    if (next && !next.disabled) showStep(next.dataset.next);
    const previous = event.target.closest('[data-prev]');
    if (previous) showStep(previous.dataset.prev);
  });

  $$('.reaction').forEach((button) => button.addEventListener('click', () => vote(button.dataset.reaction)));
  $('#resume-file').addEventListener('change', (event) => loadImageFile(event.target.files[0]));
  $('#redact-canvas').addEventListener('pointerdown', beginRedaction);
  $('#redact-canvas').addEventListener('pointermove', moveRedaction);
  $('#redact-canvas').addEventListener('pointerup', endRedaction);
  $('#redact-canvas').addEventListener('pointercancel', endRedaction);
  $('#clear-redactions').addEventListener('click', () => {
    rectangles = [];
    paintCanvas($('#redact-canvas'));
    showToast('Blackout marks cleared.');
  });

  const dropZone = $('#drop-zone');
  ['dragenter', 'dragover'].forEach((type) => dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((type) => dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragover');
  }));
  dropZone.addEventListener('drop', (event) => loadImageFile(event.dataTransfer.files[0]));

  $('#checklist').addEventListener('change', () => {
    const complete = $$('#checklist input').every((input) => input.checked);
    $('#checklist-next').disabled = !complete;
  });
  $('#resume-label').addEventListener('input', (event) => {
    const value = event.target.value;
    const looksLikeEmail = /\S+@\S+\.\S+/.test(value);
    const looksLikePhone = /(?:\+?\d[\d ()-]{7,}\d)/.test(value);
    $('#label-warning').classList.toggle('hidden', !looksLikeEmail && !looksLikePhone);
  });
  $('#post-button').addEventListener('click', async (event) => {
    if (!image) {
      showToast('Pick a resume image first.');
      showStep('pick');
      return;
    }
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const blob = await new Promise((resolve, reject) => {
        $('#redact-canvas').toBlob((value) => value ? resolve(value) : reject(new Error('Could not prepare the redacted image.')), 'image/jpeg', 0.92);
      });
      const form = new FormData();
      form.append('resume', blob, 'redacted-resume.jpg');
      form.append('label', $('#resume-label').value.trim());
      const result = await apiRequest('/api/uploads', { method: 'POST', body: form });
      $('#upload-confirmation').textContent = result.queued
        ? 'Your redacted resume is in the queue. It will be public for six hours when its turn starts.'
        : 'Your redacted resume is live now for six hours.';
      await refreshLive();
      showStep('done');
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  $('#auth-button').addEventListener('click', async () => {
    if (!authStatus.user) {
      showAuthDialog();
      return;
    }
    try {
      await apiRequest('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      authStatus.user = null;
      updateAuthControls();
      await refreshLive();
      showToast('Signed out.');
    } catch (error) {
      showToast(error.message);
    }
  });
  $('#auth-mode-toggle').addEventListener('click', () => {
    showAuthDialog(authMode === 'login' ? 'register' : 'login');
  });
  $('#auth-close').addEventListener('click', () => $('#auth-dialog').close());
  $('#auth-google').addEventListener('click', () => {
    location.assign('/api/auth/google');
  });
  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('#auth-submit');
    submit.disabled = true;
    $('#auth-error').textContent = '';
    try {
      const result = await apiRequest(`/api/auth/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: $('#auth-email').value,
          password: $('#auth-password').value,
        }),
      });
      authStatus.user = result.user;
      updateAuthControls();
      $('#auth-dialog').close();
      await refreshLive();
      showToast(authMode === 'register' ? 'Account created.' : 'Signed in.');
    } catch (error) {
      $('#auth-error').textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  $('#report-button').addEventListener('click', () => {
    if (!liveData?.resume) return showToast('There is no live resume to report.');
    if (liveData.resume.reported) return showToast('Already reported from this browser.');
    $('#report-dialog').showModal();
  });
  $('#report-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const reason = $('input[name="reason"]:checked', event.currentTarget)?.value;
    if (!reason || !liveData?.resume) return;
    $('#send-report').disabled = true;
    try {
      await apiRequest('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      liveData.resume.reported = true;
      renderLive();
      $('#report-dialog').close();
      showToast('Report received.');
    } catch (error) {
      showToast(error.message);
    } finally {
      $('#send-report').disabled = false;
    }
  });
  $('#share-button').addEventListener('click', async () => {
    const url = `${location.href.split('#')[0]}#live`;
    try {
      if (navigator.share) await navigator.share({ title: 'RESUME ROAST', text: 'Your resume. Six hours. No mercy.', url });
      else if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        showToast('Live link copied. Send in the group chat.');
      } else showToast(url);
    } catch (error) {
      if (error.name !== 'AbortError') showToast('Copy the page address to share the live one.');
    }
  });

  renderLive();
  updateAuthControls();
  refreshAuthStatus();
  refreshLive();
  setInterval(renderCountdown, 1000);
  setInterval(refreshLive, 15000);
  if (location.hash === '#upload') showView('upload', false);
  else showView('live', false);

  window.addEventListener('beforeunload', () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  });
})();