const elements = {
  mainApp: document.getElementById('mainApp'),
  albumScreen: document.getElementById('albumScreen'),
  albumsRow: document.getElementById('albumsRow'),
  searchResultsRow: document.getElementById('searchResultsRow'),
  searchEmptyState: document.getElementById('searchEmptyState'),
  searchInput: document.getElementById('searchInput'),
  editModalBackdrop: document.getElementById('editModalBackdrop'),
  editModal: document.getElementById('editModal'),
  albumNameInput: document.getElementById('albumNameInput'),
  albumPagesInput: document.getElementById('albumPagesInput'),
  albumSlotsInput: document.getElementById('albumSlotsInput'),
  colorGrid: document.getElementById('colorGrid'),
  cancelEditBtn: document.getElementById('cancelEditBtn'),
  saveEditBtn: document.getElementById('saveEditBtn'),
  selectedColorDot: document.getElementById('selectedColorDot'),
  selectedColorText: document.getElementById('selectedColorText'),
  contextMenuBackdrop: document.getElementById('contextMenuBackdrop'),
  contextMenu: document.getElementById('contextMenu'),
  contextMenuTitle: document.getElementById('contextMenuTitle'),
  contextEditBtn: document.getElementById('contextEditBtn'),
  contextRenameBtn: document.getElementById('contextRenameBtn'),
  contextDeleteBtn: document.getElementById('contextDeleteBtn'),
  backToAlbumsBtn: document.getElementById('backToAlbumsBtn'),
  screenAlbumTitle: document.getElementById('screenAlbumTitle'),
  screenAlbumMeta: document.getElementById('screenAlbumMeta'),
  mainScreenTitle: document.getElementById('mainScreenTitle'),
  albumsView: document.getElementById('albumsView'),
  searchView: document.getElementById('searchView'),
  addView: document.getElementById('addView'),
  navAlbumsBtn: document.getElementById('navAlbumsBtn'),
  navAddBtn: document.getElementById('navAddBtn'),
  navSearchBtn: document.getElementById('navSearchBtn'),
  createAlbumBtn: document.getElementById('createAlbumBtn'),
  appVersion: document.getElementById('appVersion'),
  albumDetailView: document.getElementById('albumDetailView'),
  addCardView: document.getElementById('addCardView'),
  openAddCardBtn: document.getElementById('openAddCardBtn'),
  addFirstCardBtn: document.getElementById('addFirstCardBtn'),
  backToAlbumBtn: document.getElementById('backToAlbumBtn'),
  cardSearchInput: document.getElementById('cardSearchInput')
};

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 12;

const presetColors = [
  { label: 'Blu', value: '#4f7cff' },
  { label: 'Rosso', value: '#ff5c5c' },
  { label: 'Verde', value: '#43b86b' },
  { label: 'Giallo', value: '#f6c744' },
  { label: 'Viola', value: '#8c6cff' },
  { label: 'Arancione', value: '#ff944d' },
  { label: 'Rosa', value: '#ff78b2' },
  { label: 'Grigio', value: '#8f98a3' }
];

const state = {
  currentAlbumCard: null,
  contextAlbumCard: null,
  openedAlbumCard: null,
  selectedColor: '#4f7cff',
  isCustomColor: false,
  activeView: 'albums',
  activeAlbumView: 'detail',
  contextMenuOpenedAt: 0,
  lastContextActionAt: 0
};

function clearTextSelection() {
  const selection = window.getSelection?.();

  if (!selection) {
    return;
  }

  try {
    selection.removeAllRanges();
  } catch (_error) {
    // Safari ama complicare anche questo.
  }
}

function setSelectionSuppressed(isSuppressed) {
  document.documentElement.classList.toggle('suppress-selection', isSuppressed);
  document.body?.classList.toggle('suppress-selection', isSuppressed);

  if (isSuppressed) {
    clearTextSelection();
  }
}

function requestSkipWaiting(worker) {
  if (!worker) return;

  try {
    worker.postMessage({ type: 'SKIP_WAITING' });
  } catch (_error) {
    // Il browser fa il browser.
  }
}

function installAutoUpdateHooks(registration) {
  if (!registration || !('serviceWorker' in navigator)) {
    return;
  }

  let isRefreshing = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (isRefreshing) {
      return;
    }

    isRefreshing = true;
    window.location.reload();
  });

  if (registration.waiting) {
    requestSkipWaiting(registration.waiting);
  }

  registration.addEventListener('updatefound', () => {
    const installingWorker = registration.installing;

    if (!installingWorker) {
      return;
    }

    installingWorker.addEventListener('statechange', () => {
      if (installingWorker.state !== 'installed') {
        return;
      }

      if (navigator.serviceWorker.controller) {
        requestSkipWaiting(installingWorker);
      }
    });
  });
}

async function getServiceWorkerVersion() {
  try {
    const response = await fetch('service-worker.js', {
      cache: 'no-store',
      credentials: 'same-origin'
    });

    if (!response.ok) {
      return '';
    }

    const source = await response.text();
    const versionMatch = source.match(/const\s+VERSION\s*=\s*['"]([^'"]+)['"]/i)
      || source.match(/const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/i);

    return versionMatch?.[1] || '';
  } catch (_error) {
    return '';
  }
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return null;
  }

  try {
    const swVersion = await getServiceWorkerVersion();
    const swUrl = swVersion
      ? `service-worker.js?v=${encodeURIComponent(swVersion)}`
      : 'service-worker.js';

    const registration = await navigator.serviceWorker.register(swUrl, {
      scope: './'
    });

    installAutoUpdateHooks(registration);

    registration.update().catch(() => {});

    window.addEventListener('load', () => {
      registration.update().catch(() => {});
    }, { once: true });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        registration.update().catch(() => {});
      }
    });

    return registration;
  } catch (_error) {
    return null;
  }
}

async function extractVersionFromServiceWorker() {
  const version = await getServiceWorkerVersion();
  return version || '';
}

async function renderAppVersion() {
  const version = await extractVersionFromServiceWorker();

  if (!version) {
    elements.appVersion.hidden = true;
    elements.appVersion.textContent = '';
    return;
  }

  elements.appVersion.textContent = `v${version}`;
  elements.appVersion.hidden = false;
}

function normalizeHexColor(color) {
  return String(color).trim().toLowerCase();
}

function isPresetColor(color) {
  return presetColors.some(({ value }) => normalizeHexColor(value) === normalizeHexColor(color));
}

function getSourceCard(card) {
  return card?.sourceCard || card;
}

function updateSelectedColorPreview() {
  elements.selectedColorDot.style.background = state.selectedColor;
  elements.selectedColorText.textContent = state.isCustomColor
    ? `Colore personalizzato: ${state.selectedColor.toUpperCase()}`
    : `Colore selezionato: ${state.selectedColor.toUpperCase()}`;
}

function renderColorGrid(activeColor) {
  elements.colorGrid.innerHTML = '';
  const normalizedActive = normalizeHexColor(activeColor);

  presetColors.forEach(({ label, value }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `color-option${normalizeHexColor(value) === normalizedActive ? ' selected' : ''}`;
    button.style.background = value;
    button.title = label;
    button.setAttribute('aria-label', label);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.selectedColor = value;
      state.isCustomColor = false;
      renderColorGrid(state.selectedColor);
    });

    elements.colorGrid.appendChild(button);
  });

  const customTrigger = document.createElement('div');
  customTrigger.className = `color-picker-trigger${state.isCustomColor ? ' selected' : ''}`;
  customTrigger.title = 'Scegli un colore personalizzato';
  customTrigger.setAttribute('aria-label', 'Apri tavolozza colori');
  customTrigger.setAttribute('role', 'button');
  customTrigger.tabIndex = 0;
  customTrigger.innerHTML = `
    <span>+</span>
    <input class="hidden-color-input" type="color" value="${state.selectedColor}" />
  `;

  const colorInput = customTrigger.querySelector('input');

  function applyCustomColor(value, rerender = false) {
    state.selectedColor = value;
    state.isCustomColor = !isPresetColor(value);
    updateSelectedColorPreview();

    if (rerender) {
      renderColorGrid(state.selectedColor);
    }
  }

  function openPicker(event) {
    event.preventDefault();
    event.stopPropagation();
    colorInput.click();
  }

  customTrigger.addEventListener('click', openPicker);
  customTrigger.addEventListener('pointerdown', (event) => event.stopPropagation());
  customTrigger.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });
  customTrigger.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      openPicker(event);
    }
  });

  colorInput.addEventListener('click', (event) => event.stopPropagation());
  colorInput.addEventListener('pointerdown', (event) => event.stopPropagation());
  colorInput.addEventListener('input', (event) => {
    event.stopPropagation();
    applyCustomColor(event.target.value);
  });
  colorInput.addEventListener('change', (event) => {
    event.stopPropagation();
    applyCustomColor(event.target.value, true);
  });

  elements.colorGrid.appendChild(customTrigger);
  updateSelectedColorPreview();
}

function setActiveAlbumView(viewName) {
  state.activeAlbumView = viewName;
  elements.albumDetailView.classList.toggle('active', viewName === 'detail');
  elements.addCardView.classList.toggle('active', viewName === 'add-card');

  if (viewName === 'add-card') {
    elements.cardSearchInput.value = '';
    requestAnimationFrame(() => {
      elements.cardSearchInput.focus();
    });
  }
}

function refreshOpenedAlbumScreen() {
  if (!state.openedAlbumCard) {
    return;
  }

  const { name, pages, slots } = state.openedAlbumCard.albumData;
  elements.screenAlbumTitle.textContent = name;
  elements.screenAlbumMeta.textContent = `${pages} pagine • ${pages * slots} slot totali`;
}

function openAlbumScreen(card) {
  state.openedAlbumCard = getSourceCard(card);
  refreshOpenedAlbumScreen();
  setActiveAlbumView('detail');
  elements.mainApp.classList.add('hidden');
  elements.albumScreen.classList.add('open');
}

function closeAlbumScreen() {
  state.openedAlbumCard = null;
  setActiveAlbumView('detail');
  elements.albumScreen.classList.remove('open');
  elements.mainApp.classList.remove('hidden');
}

function openAddCardScreen() {
  if (!state.openedAlbumCard) {
    return;
  }

  setActiveAlbumView('add-card');
}

function closeAddCardScreen() {
  setActiveAlbumView('detail');
}

function openEditModal(card) {
  const sourceCard = getSourceCard(card);
  const { name, pages, slots, color } = sourceCard.albumData;

  state.currentAlbumCard = sourceCard;
  state.selectedColor = color;
  state.isCustomColor = !isPresetColor(color);

  elements.albumNameInput.value = name;
  elements.albumPagesInput.value = pages;
  elements.albumSlotsInput.value = slots;

  renderColorGrid(color);
  elements.editModalBackdrop.classList.add('open');
}

function closeEditModal() {
  elements.editModalBackdrop.classList.remove('open');
  state.currentAlbumCard = null;
}

function openContextMenu(card) {
  const sourceCard = getSourceCard(card);
  state.contextAlbumCard = sourceCard;
  state.contextMenuOpenedAt = performance.now();
  elements.contextMenuTitle.textContent = sourceCard.albumData.name;
  elements.contextMenuBackdrop.classList.add('open');
}

function closeContextMenu() {
  elements.contextMenuBackdrop.classList.remove('open');
  state.contextAlbumCard = null;
  state.contextMenuOpenedAt = 0;
  setSelectionSuppressed(false);
  clearTextSelection();
}

function contextMenuJustOpened() {
  return performance.now() - state.contextMenuOpenedAt < 320;
}

function handleContextMenuAction(action) {
  return (event) => {
    event.preventDefault();
    event.stopPropagation();

    const now = performance.now();
    if (now - state.lastContextActionAt < 250) {
      return;
    }

    state.lastContextActionAt = now;

    if (!state.contextAlbumCard) {
      return;
    }

    const targetCard = state.contextAlbumCard;
    closeContextMenu();
    action(targetCard);
  };
}

function updateAlbumCard(card) {
  const sourceCard = getSourceCard(card);
  const { name, color, pages, slots } = sourceCard.albumData;

  sourceCard.querySelector('.book-icon').style.setProperty('--album-color', color);
  sourceCard.querySelector('.album-title').textContent = name;
  sourceCard.querySelector('.album-meta').textContent = `0/${pages * slots}`;

  refreshOpenedAlbumScreen();
}

function renameAlbum(card) {
  const sourceCard = getSourceCard(card);
  const newName = window.prompt('Nuovo nome album', sourceCard.albumData.name);
  const trimmedName = newName?.trim();

  if (!trimmedName) {
    return;
  }

  sourceCard.albumData.name = trimmedName;
  updateAlbumCard(sourceCard);
  renderSearchResults(elements.searchInput.value);
}

function deleteAlbum(card) {
  const sourceCard = getSourceCard(card);

  if (state.openedAlbumCard === sourceCard) {
    closeAlbumScreen();
  }

  sourceCard.remove();
  renderSearchResults(elements.searchInput.value);
}

function getNextAlbumNumber() {
  const usedNumbers = Array.from(elements.albumsRow.querySelectorAll('.album-card'))
    .map((card) => {
      const match = card.albumData.name.match(/^Album\s+(\d+)$/i);
      return match ? Number(match[1]) : null;
    })
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);

  let nextNumber = 1;

  for (const value of usedNumbers) {
    if (value > nextNumber) {
      break;
    }

    if (value === nextNumber) {
      nextNumber += 1;
    }
  }

  return nextNumber;
}

function createAlbumCardMarkup(albumData) {
  return `
    <div class="album-cover">
      <div class="book-icon" style="--album-color:${albumData.color}"></div>
      <div class="album-info">
        <div class="album-title"></div>
        <div class="album-meta"></div>
      </div>
    </div>
  `;
}

function createAlbum(openEditor = false) {
  const nextAlbumNumber = getNextAlbumNumber();
  const defaultColor = presetColors[(nextAlbumNumber - 1) % presetColors.length].value;

  const card = document.createElement('article');
  card.className = 'album-card';
  card.albumData = {
    name: `Album ${nextAlbumNumber}`,
    color: defaultColor,
    pages: 10,
    slots: 9
  };
  card.innerHTML = createAlbumCardMarkup(card.albumData);

  updateAlbumCard(card);
  attachAlbumInteractions(card);
  elements.albumsRow.appendChild(card);
  renderSearchResults(elements.searchInput.value);

  if (openEditor) {
    setActiveView('albums');
    openEditModal(card);
  }
}

function renderSearchResults(query = '') {
  const normalizedQuery = query.trim().toLowerCase();
  const cards = Array.from(elements.albumsRow.querySelectorAll('.album-card'));

  elements.searchResultsRow.innerHTML = '';

  const matches = cards.filter((card) => {
    if (!normalizedQuery) {
      return true;
    }

    const { name, pages, slots } = card.albumData;
    const searchableText = `${name} ${pages} ${slots}`.toLowerCase();
    return searchableText.includes(normalizedQuery);
  });

  matches.forEach((originalCard) => {
    const clone = originalCard.cloneNode(true);
    clone.albumData = originalCard.albumData;
    clone.sourceCard = originalCard;
    attachAlbumInteractions(clone);
    elements.searchResultsRow.appendChild(clone);
  });

  elements.searchEmptyState.hidden = matches.length > 0;
}

function setActiveView(viewName) {
  state.activeView = viewName;

  elements.albumsView.classList.toggle('active', viewName === 'albums');
  elements.searchView.classList.toggle('active', viewName === 'search');
  elements.addView.classList.toggle('active', viewName === 'add');

  elements.navAlbumsBtn.classList.toggle('active', viewName === 'albums');
  elements.navSearchBtn.classList.toggle('active', viewName === 'search');
  elements.navAddBtn.classList.toggle('active', viewName === 'add');

  if (viewName === 'albums') {
    elements.mainScreenTitle.textContent = 'Album';
    return;
  }

  if (viewName === 'search') {
    elements.mainScreenTitle.textContent = 'Cerca';
    renderSearchResults(elements.searchInput.value);
    return;
  }

  elements.mainScreenTitle.textContent = 'Aggiungi';
}

function attachAlbumInteractions(card) {
  const cover = card.querySelector('.album-cover');

  let pressTimer = null;
  let longPressTriggered = false;
  let pointerMoved = false;
  let startX = 0;
  let startY = 0;
  let activePointerId = null;

  function clearPressTimer() {
    if (!pressTimer) {
      return;
    }

    clearTimeout(pressTimer);
    pressTimer = null;
  }

  function resetPressState() {
    clearPressTimer();
    pointerMoved = false;
    activePointerId = null;

    if (!elements.contextMenuBackdrop.classList.contains('open')) {
      setSelectionSuppressed(false);
    }
  }

  function startPress(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    startX = event.clientX;
    startY = event.clientY;
    pointerMoved = false;
    longPressTriggered = false;
    activePointerId = event.pointerId;
    clearPressTimer();
    setSelectionSuppressed(true);
    clearTextSelection();

    if (cover.setPointerCapture) {
      try {
        cover.setPointerCapture(event.pointerId);
      } catch (_error) {
        // Ignorato. I browser fanno cose browser.
      }
    }

    pressTimer = setTimeout(() => {
      longPressTriggered = true;
      clearPressTimer();
      setSelectionSuppressed(true);
      clearTextSelection();
      openContextMenu(card);
    }, LONG_PRESS_MS);
  }

  cover.addEventListener('pointerdown', startPress);

  cover.addEventListener('pointermove', (event) => {
    if (activePointerId !== event.pointerId || longPressTriggered) {
      return;
    }

    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;

    if (Math.hypot(deltaX, deltaY) <= MOVE_TOLERANCE_PX) {
      return;
    }

    pointerMoved = true;
    clearPressTimer();
  });

  cover.addEventListener('pointerup', (event) => {
    if (activePointerId !== event.pointerId) {
      return;
    }

    const shouldOpenAlbum = !longPressTriggered && !pointerMoved;

    if (cover.releasePointerCapture && cover.hasPointerCapture?.(event.pointerId)) {
      try {
        cover.releasePointerCapture(event.pointerId);
      } catch (_error) {
        // Sempre i browser. Sempre loro.
      }
    }

    resetPressState();

    if (!shouldOpenAlbum) {
      event.preventDefault();
      clearTextSelection();
      return;
    }

    setSelectionSuppressed(false);
    clearTextSelection();
    openAlbumScreen(card);
  });

  cover.addEventListener('pointercancel', (event) => {
    if (activePointerId === event.pointerId) {
      resetPressState();
    }
  });

  cover.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse' && activePointerId === event.pointerId && !longPressTriggered) {
      resetPressState();
    }
  });

  cover.addEventListener('lostpointercapture', () => {
    if (!longPressTriggered) {
      resetPressState();
    }
  });

  cover.addEventListener('touchstart', () => {
    setSelectionSuppressed(true);
    clearTextSelection();
  }, { passive: true });
  cover.addEventListener('touchend', () => {
    if (!elements.contextMenuBackdrop.classList.contains('open')) {
      setSelectionSuppressed(false);
    }
    clearTextSelection();
  }, { passive: true });

  cover.addEventListener('contextmenu', (event) => event.preventDefault());
  cover.addEventListener('selectstart', (event) => event.preventDefault());
  cover.addEventListener('dragstart', (event) => event.preventDefault());
}


function saveAlbumChanges() {
  if (!state.currentAlbumCard) {
    return;
  }

  state.currentAlbumCard.albumData.name = elements.albumNameInput.value.trim() || state.currentAlbumCard.albumData.name;
  state.currentAlbumCard.albumData.color = state.selectedColor;
  state.currentAlbumCard.albumData.pages = Math.max(1, Number(elements.albumPagesInput.value) || 1);
  state.currentAlbumCard.albumData.slots = Math.max(1, Number(elements.albumSlotsInput.value) || 1);

  updateAlbumCard(state.currentAlbumCard);
  renderSearchResults(elements.searchInput.value);
  closeEditModal();
}

function bindEvents() {
  elements.backToAlbumsBtn.addEventListener('click', closeAlbumScreen);
  elements.openAddCardBtn.addEventListener('click', openAddCardScreen);
  elements.addFirstCardBtn.addEventListener('click', openAddCardScreen);
  elements.backToAlbumBtn.addEventListener('click', closeAddCardScreen);
  elements.cancelEditBtn.addEventListener('click', closeEditModal);
  elements.saveEditBtn.addEventListener('click', saveAlbumChanges);

  const onContextEdit = handleContextMenuAction((targetCard) => {
    openEditModal(targetCard);
  });
  const onContextRename = handleContextMenuAction((targetCard) => {
    renameAlbum(targetCard);
  });
  const onContextDelete = handleContextMenuAction((targetCard) => {
    deleteAlbum(targetCard);
  });

  ['pointerup', 'click'].forEach((eventName) => {
    elements.contextEditBtn.addEventListener(eventName, onContextEdit);
    elements.contextRenameBtn.addEventListener(eventName, onContextRename);
    elements.contextDeleteBtn.addEventListener(eventName, onContextDelete);
  });

  elements.editModalBackdrop.addEventListener('click', (event) => {
    if (event.target === elements.editModalBackdrop) {
      closeEditModal();
    }
  });

  elements.contextMenuBackdrop.addEventListener('pointerup', (event) => {
    if (event.target !== elements.contextMenuBackdrop) {
      return;
    }

    if (contextMenuJustOpened()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    closeContextMenu();
  });

  elements.contextMenuBackdrop.addEventListener('click', (event) => {
    if (event.target !== elements.contextMenuBackdrop) {
      return;
    }

    if (contextMenuJustOpened()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    closeContextMenu();
  });

  elements.editModal.addEventListener('click', (event) => event.stopPropagation());
  elements.contextMenu.addEventListener('click', (event) => event.stopPropagation());

  elements.navAlbumsBtn.addEventListener('click', () => setActiveView('albums'));
  elements.navSearchBtn.addEventListener('click', () => setActiveView('search'));
  elements.navAddBtn.addEventListener('click', () => {
    createAlbum(false);
    setActiveView('albums');
  });
  elements.createAlbumBtn.addEventListener('click', () => createAlbum(false));
  elements.searchInput.addEventListener('input', (event) => renderSearchResults(event.target.value));
}

async function init() {
  const serviceWorkerReady = registerServiceWorker();

  bindEvents();
  renderSearchResults();

  await serviceWorkerReady;
  await renderAppVersion();
}

init();
