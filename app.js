const $ = (id) => document.getElementById(id);

const elements = Object.fromEntries([
  'mainApp','albumScreen','albumsRow','albumsEmptyState','createFirstAlbumBtn','createFirstAlbumIcon','searchResultsRow','searchEmptyState','searchInput',
  'editModalBackdrop','editModal','albumNameInput','albumPagesInput','albumSlotsInput',
  'colorGrid','cancelEditBtn','saveEditBtn','selectedColorDot','selectedColorText',
  'contextMenuBackdrop','contextMenu','contextMenuTitle','contextEditBtn','contextRenameBtn','contextDeleteBtn',
  'backToAlbumsBtn','screenAlbumTitle','screenAlbumMeta','mainScreenTitle','appOwnerBtn','appOwnerName',
  'albumsView','searchView','addView','navAlbumsBtn','navAddBtn','navSearchBtn','createAlbumBtn',
  'appVersion','albumDetailView','addCardView','openAddCardBtn','addFirstCardBtn','backToAlbumBtn','cardSearchInput'
].map((id) => [id, $(id)]));

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 12;
const OWNER_NAME_STORAGE_KEY = 'pokealbum-owner-name';
const DEFAULT_OWNER_NAME = 'IL TUO NOME';

const presetColors = [
  ['Blu', '#4f7cff'],
  ['Azzurro', '#33b1ff'],
  ['Verde', '#43b86b'],
  ['Oro', '#d9b44a'],
  ['Viola', '#8c6cff'],
  ['Arancione', '#ff944d'],
  ['Rosa', '#ff78b2'],
  ['Grigio', '#8f98a3']
].map(([label, value]) => ({ label, value }));

const state = {
  currentAlbumCard: null,
  contextAlbumCard: null,
  openedAlbumCard: null,
  selectedColor: presetColors[0].value,
  isCustomColor: false,
  activeView: 'albums',
  activeAlbumView: 'detail',
  contextMenuOpenedAt: 0,
  lastContextActionAt: 0
};

const normalizeHexColor = (value) => String(value || '').trim().toLowerCase();
const isPresetColor = (value) => presetColors.some((color) => normalizeHexColor(color.value) === normalizeHexColor(value));
const getSourceCard = (card) => card?.sourceCard || card;
const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {} };
const stop = (event) => { event.preventDefault(); event.stopPropagation(); };
const clearTextSelection = () => { try { window.getSelection?.().removeAllRanges(); } catch {} };

function toggleSelectionSuppressed(enabled) {
  document.documentElement.classList.toggle('suppress-selection', enabled);
  document.body?.classList.toggle('suppress-selection', enabled);
  if (enabled) clearTextSelection();
}

function setOpen(backdrop, open) {
  backdrop.classList.toggle('open', open);
}

function setSectionView(viewName) {
  state.activeView = viewName;
  const viewMap = {
    albums: ['albumsView', 'navAlbumsBtn', 'Album'],
    search: ['searchView', 'navSearchBtn', 'Cerca'],
    add: ['addView', 'navAddBtn', 'Aggiungi']
  };

  Object.entries({ albums: 'albumsView', search: 'searchView', add: 'addView' })
    .forEach(([name, key]) => elements[key]?.classList.toggle('active', name === viewName));

  Object.entries({ albums: 'navAlbumsBtn', search: 'navSearchBtn', add: 'navAddBtn' })
    .forEach(([name, key]) => elements[key]?.classList.toggle('active', name === viewName));

  if (elements.mainScreenTitle) {
    elements.mainScreenTitle.textContent = viewMap[viewName]?.[2] || '';
  }

  if (viewName === 'search' && elements.searchInput) {
    renderSearchResults(elements.searchInput.value);
  }
}

function setAlbumView(viewName) {
  state.activeAlbumView = viewName;
  elements.albumDetailView.classList.toggle('active', viewName === 'detail');
  elements.addCardView.classList.toggle('active', viewName === 'add-card');

  if (viewName === 'add-card') {
    elements.cardSearchInput.value = '';
    requestAnimationFrame(() => elements.cardSearchInput.focus());
  }
}

function normalizeOwnerName(name) {
  const cleaned = String(name || '').trim().replace(/\s+/g, ' ');
  return cleaned ? cleaned.toUpperCase() : DEFAULT_OWNER_NAME;
}

function renderOwnerName() {
  elements.appOwnerName.textContent = normalizeOwnerName(read(OWNER_NAME_STORAGE_KEY));
}

function editOwnerName() {
  const currentName = normalizeOwnerName(read(OWNER_NAME_STORAGE_KEY));
  const value = window.prompt('Nome del proprietario', currentName === DEFAULT_OWNER_NAME ? '' : currentName);
  if (value === null) return;
  const normalized = normalizeOwnerName(value);
  write(OWNER_NAME_STORAGE_KEY, normalized === DEFAULT_OWNER_NAME ? null : normalized);
  renderOwnerName();
}

async function getServiceWorkerVersion() {
  try {
    const response = await fetch('service-worker.js', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return '';
    const source = await response.text();
    return source.match(/const\s+(?:VERSION|APP_VERSION)\s*=\s*['"]([^'"]+)['"]/i)?.[1] || '';
  } catch {
    return '';
  }
}

function requestSkipWaiting(worker) {
  try { worker?.postMessage({ type: 'SKIP_WAITING' }); } catch {}
}

function installAutoUpdateHooks(registration) {
  if (!registration || !('serviceWorker' in navigator)) return;

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  if (registration.waiting) requestSkipWaiting(registration.waiting);

  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;

    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        requestSkipWaiting(worker);
      }
    });
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  try {
    const version = await getServiceWorkerVersion();
    const url = version ? `service-worker.js?v=${encodeURIComponent(version)}` : 'service-worker.js';
    const registration = await navigator.serviceWorker.register(url, { scope: './' });
    installAutoUpdateHooks(registration);

    const update = () => registration.update().catch(() => {});
    update();
    window.addEventListener('load', update, { once: true });
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && update());
    return version;
  } catch {
    return '';
  }
}

function renderAppVersion(version) {
  elements.appVersion.hidden = !version;
  elements.appVersion.textContent = version ? `v${version}` : '';
}

function syncAlbumsEmptyState() {
  const hasAlbums = elements.albumsRow.querySelector('.album-card') !== null;

  elements.albumsEmptyState.hidden = hasAlbums;
  elements.albumsEmptyState.classList.toggle('is-hidden', hasAlbums);
  elements.albumsEmptyState.style.display = hasAlbums ? 'none' : '';

  elements.albumsRow.hidden = !hasAlbums;
  elements.albumsRow.classList.toggle('is-hidden', !hasAlbums);
  elements.albumsRow.style.display = hasAlbums ? '' : 'none';
}

function updateSelectedColorPreview() {
  elements.selectedColorDot.style.background = state.selectedColor;
  elements.selectedColorText.textContent = `${state.isCustomColor ? 'Colore personalizzato' : 'Colore selezionato'}: ${state.selectedColor.toUpperCase()}`;
}

function renderColorGrid(activeColor = state.selectedColor) {
  state.selectedColor = activeColor;
  elements.colorGrid.innerHTML = '';
  const selected = normalizeHexColor(activeColor);

  const selectColor = (value, rerender = true) => {
    state.selectedColor = value;
    state.isCustomColor = !isPresetColor(value);
    if (rerender) renderColorGrid(value);
    else updateSelectedColorPreview();
  };

  presetColors.forEach(({ label, value }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `color-option${normalizeHexColor(value) === selected ? ' selected' : ''}`;
    button.style.background = value;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', (event) => {
      stop(event);
      selectColor(value);
    });
    elements.colorGrid.appendChild(button);
  });

  const trigger = document.createElement('div');
  trigger.className = `color-picker-trigger${state.isCustomColor ? ' selected' : ''}`;
  trigger.title = 'Scegli un colore personalizzato';
  trigger.setAttribute('aria-label', 'Apri tavolozza colori');
  trigger.setAttribute('role', 'button');
  trigger.tabIndex = 0;
  trigger.innerHTML = `<span>+</span><input class="hidden-color-input" type="color" value="${state.selectedColor}" />`;

  const input = trigger.querySelector('input');
  const openPicker = (event) => { stop(event); input.click(); };

  ['click', 'pointerdown'].forEach((name) => trigger.addEventListener(name, (event) => name === 'click' ? openPicker(event) : event.stopPropagation()));
  trigger.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });
  trigger.addEventListener('keydown', (event) => (event.key === 'Enter' || event.key === ' ') && openPicker(event));
  ['click', 'pointerdown'].forEach((name) => input.addEventListener(name, (event) => event.stopPropagation()));
  input.addEventListener('input', (event) => { event.stopPropagation(); selectColor(event.target.value, false); });
  input.addEventListener('change', (event) => { event.stopPropagation(); selectColor(event.target.value); });

  elements.colorGrid.appendChild(trigger);
  updateSelectedColorPreview();
}

function refreshOpenedAlbumScreen() {
  if (!state.openedAlbumCard) return;
  const { name, pages, slots } = state.openedAlbumCard.albumData;
  elements.screenAlbumTitle.textContent = name;
  elements.screenAlbumMeta.textContent = `${pages} pagine • ${pages * slots} slot totali`;
}

function openAlbumScreen(card) {
  state.openedAlbumCard = getSourceCard(card);
  refreshOpenedAlbumScreen();
  setAlbumView('detail');
  elements.mainApp.classList.add('hidden');
  elements.albumScreen.classList.add('open');
}

function closeAlbumScreen() {
  state.openedAlbumCard = null;
  setAlbumView('detail');
  elements.albumScreen.classList.remove('open');
  elements.mainApp.classList.remove('hidden');
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
  setOpen(elements.editModalBackdrop, true);
}

function closeEditModal() {
  state.currentAlbumCard = null;
  setOpen(elements.editModalBackdrop, false);
}

function openContextMenu(card) {
  state.contextAlbumCard = getSourceCard(card);
  state.contextMenuOpenedAt = performance.now();
  elements.contextMenuTitle.textContent = state.contextAlbumCard.albumData.name;
  setOpen(elements.contextMenuBackdrop, true);
}

function closeContextMenu() {
  state.contextAlbumCard = null;
  state.contextMenuOpenedAt = 0;
  setOpen(elements.contextMenuBackdrop, false);
  toggleSelectionSuppressed(false);
  clearTextSelection();
}

const contextMenuJustOpened = () => performance.now() - state.contextMenuOpenedAt < 320;

function runContextAction(action) {
  return (event) => {
    stop(event);
    const now = performance.now();
    if (!state.contextAlbumCard || now - state.lastContextActionAt < 250) return;
    state.lastContextActionAt = now;
    const card = state.contextAlbumCard;
    closeContextMenu();
    action(card);
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
  const name = window.prompt('Nuovo nome album', sourceCard.albumData.name)?.trim();
  if (!name) return;
  sourceCard.albumData.name = name;
  updateAlbumCard(sourceCard);
  renderSearchResults(elements.searchInput.value);
}

function deleteAlbum(card) {
  const sourceCard = getSourceCard(card);
  if (state.openedAlbumCard === sourceCard) closeAlbumScreen();
  sourceCard.remove();
  syncAlbumsEmptyState();
  renderSearchResults(elements.searchInput.value);
}

function getNextAlbumNumber() {
  const numbers = [...elements.albumsRow.querySelectorAll('.album-card')]
    .map((card) => Number(card.albumData.name.match(/^Album\s+(\d+)$/i)?.[1]))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);

  let next = 1;
  for (const number of numbers) {
    if (number > next) break;
    if (number === next) next += 1;
  }
  return next;
}

function createAlbumCardMarkup({ color }) {
  return `
    <div class="album-cover">
      <div class="book-icon" style="--album-color:${color}"></div>
      <div class="album-info">
        <div class="album-title"></div>
        <div class="album-meta"></div>
      </div>
    </div>`;
}

function createAlbum() {
  const next = getNextAlbumNumber();
  const card = document.createElement('article');
  card.className = 'album-card';
  card.albumData = {
    name: `Album ${next}`,
    color: presetColors[(next - 1) % presetColors.length].value,
    pages: 10,
    slots: 9
  };
  card.innerHTML = createAlbumCardMarkup(card.albumData);
  updateAlbumCard(card);
  attachAlbumInteractions(card);
  elements.albumsRow.appendChild(card);
  syncAlbumsEmptyState();
  renderSearchResults(elements.searchInput.value);
}

function renderSearchResults(query = '') {
  const value = query.trim().toLowerCase();
  const cards = [...elements.albumsRow.querySelectorAll('.album-card')].filter((card) => {
    if (!value) return true;
    const { name, pages, slots } = card.albumData;
    return `${name} ${pages} ${slots}`.toLowerCase().includes(value);
  });

  elements.searchResultsRow.innerHTML = '';
  cards.forEach((originalCard) => {
    const clone = originalCard.cloneNode(true);
    clone.albumData = originalCard.albumData;
    clone.sourceCard = originalCard;
    attachAlbumInteractions(clone);
    elements.searchResultsRow.appendChild(clone);
  });
  elements.searchEmptyState.hidden = cards.length > 0;
}

function attachAlbumInteractions(card) {
  const cover = card.querySelector('.album-cover');
  let pressTimer = 0;
  let longPressTriggered = false;
  let pointerMoved = false;
  let activePointerId = null;
  let startX = 0;
  let startY = 0;

  const clearPressTimer = () => pressTimer && clearTimeout(pressTimer);
  const resetPressState = () => {
    clearPressTimer();
    pressTimer = 0;
    pointerMoved = false;
    activePointerId = null;
    card.classList.remove('is-pressed');
    if (!elements.contextMenuBackdrop.classList.contains('open')) toggleSelectionSuppressed(false);
  };

  cover.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    startX = event.clientX;
    startY = event.clientY;
    activePointerId = event.pointerId;
    pointerMoved = false;
    longPressTriggered = false;
    card.classList.add('is-pressed');
    toggleSelectionSuppressed(true);
    clearTextSelection();
    try { cover.setPointerCapture?.(event.pointerId); } catch {}

    clearPressTimer();
    pressTimer = setTimeout(() => {
      longPressTriggered = true;
      pressTimer = 0;
      toggleSelectionSuppressed(true);
      clearTextSelection();
      openContextMenu(card);
    }, LONG_PRESS_MS);
  });

  cover.addEventListener('pointermove', (event) => {
    if (activePointerId !== event.pointerId || longPressTriggered) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) <= MOVE_TOLERANCE_PX) return;
    pointerMoved = true;
    clearPressTimer();
    pressTimer = 0;
  });

  cover.addEventListener('pointerup', (event) => {
    if (activePointerId !== event.pointerId) return;
    const shouldOpen = !longPressTriggered && !pointerMoved;
    try {
      if (cover.hasPointerCapture?.(event.pointerId)) cover.releasePointerCapture?.(event.pointerId);
    } catch {}
    resetPressState();
    if (!shouldOpen) {
      event.preventDefault();
      clearTextSelection();
      return;
    }
    toggleSelectionSuppressed(false);
    clearTextSelection();
    openAlbumScreen(card);
  });

  cover.addEventListener('pointercancel', (event) => activePointerId === event.pointerId && resetPressState());
  cover.addEventListener('pointerleave', (event) => event.pointerType === 'mouse' && activePointerId === event.pointerId && !longPressTriggered && resetPressState());
  cover.addEventListener('lostpointercapture', () => !longPressTriggered && resetPressState());
  cover.addEventListener('touchstart', () => { toggleSelectionSuppressed(true); clearTextSelection(); }, { passive: true });
  cover.addEventListener('touchend', () => {
    if (!elements.contextMenuBackdrop.classList.contains('open')) toggleSelectionSuppressed(false);
    clearTextSelection();
  }, { passive: true });
  ['contextmenu', 'selectstart', 'dragstart'].forEach((name) => cover.addEventListener(name, (event) => event.preventDefault()));
}

function saveAlbumChanges() {
  if (!state.currentAlbumCard) return;
  Object.assign(state.currentAlbumCard.albumData, {
    name: elements.albumNameInput.value.trim() || state.currentAlbumCard.albumData.name,
    color: state.selectedColor,
    pages: Math.max(1, Number(elements.albumPagesInput.value) || 1),
    slots: Math.max(1, Number(elements.albumSlotsInput.value) || 1)
  });
  updateAlbumCard(state.currentAlbumCard);
  renderSearchResults(elements.searchInput.value);
  closeEditModal();
}

function bindEvents() {
  const createAndShowAlbums = () => {
    createAlbum();
    setSectionView('albums');
  };

  [
    ['backToAlbumsBtn', closeAlbumScreen],
    ['openAddCardBtn', () => state.openedAlbumCard && setAlbumView('add-card')],
    ['addFirstCardBtn', () => state.openedAlbumCard && setAlbumView('add-card')],
    ['backToAlbumBtn', () => setAlbumView('detail')],
    ['cancelEditBtn', closeEditModal],
    ['appOwnerBtn', editOwnerName],
    ['saveEditBtn', saveAlbumChanges],
    ['navAlbumsBtn', () => setSectionView('albums')],
    ['navSearchBtn', () => setSectionView('search')],
    ['navAddBtn', createAndShowAlbums],
    ['createAlbumBtn', createAndShowAlbums],
    ['createFirstAlbumBtn', createAndShowAlbums],
    ['createFirstAlbumIcon', createAndShowAlbums]
  ].forEach(([key, handler]) => elements[key].addEventListener('click', handler));

  elements.createFirstAlbumIcon.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    stop(event);
    createAndShowAlbums();
  });

  const contextActions = {
    contextEditBtn: runContextAction(openEditModal),
    contextRenameBtn: runContextAction(renameAlbum),
    contextDeleteBtn: runContextAction(deleteAlbum)
  };

  Object.entries(contextActions).forEach(([key, handler]) => {
    ['pointerup', 'click'].forEach((eventName) => elements[key].addEventListener(eventName, handler));
  });

  elements.searchInput.addEventListener('input', (event) => renderSearchResults(event.target.value));
  elements.editModalBackdrop.addEventListener('click', (event) => event.target === elements.editModalBackdrop && closeEditModal());
  elements.editModal.addEventListener('click', (event) => event.stopPropagation());
  elements.contextMenu.addEventListener('click', (event) => event.stopPropagation());

  ['pointerup', 'click'].forEach((eventName) => {
    elements.contextMenuBackdrop.addEventListener(eventName, (event) => {
      if (event.target !== elements.contextMenuBackdrop) return;
      if (contextMenuJustOpened()) return stop(event);
      closeContextMenu();
    });
  });
}

async function init() {
  bindEvents();
  renderOwnerName();
  syncAlbumsEmptyState();
  renderSearchResults();
  renderAppVersion(await registerServiceWorker());
}

init();
