const mainApp = document.getElementById('mainApp');
    const albumScreen = document.getElementById('albumScreen');
    const albumsRow = document.getElementById('albumsRow');
    const searchResultsRow = document.getElementById('searchResultsRow');
    const searchEmptyState = document.getElementById('searchEmptyState');
    const searchInput = document.getElementById('searchInput');
    const editModalBackdrop = document.getElementById('editModalBackdrop');
    const editModal = document.getElementById('editModal');
    const albumNameInput = document.getElementById('albumNameInput');
    const albumPagesInput = document.getElementById('albumPagesInput');
    const albumSlotsInput = document.getElementById('albumSlotsInput');
    const colorGrid = document.getElementById('colorGrid');
    const cancelEditBtn = document.getElementById('cancelEditBtn');
    const saveEditBtn = document.getElementById('saveEditBtn');
    const selectedColorDot = document.getElementById('selectedColorDot');
    const selectedColorText = document.getElementById('selectedColorText');
    const contextMenuBackdrop = document.getElementById('contextMenuBackdrop');
    const contextMenu = document.getElementById('contextMenu');
    const contextMenuTitle = document.getElementById('contextMenuTitle');
    const contextEditBtn = document.getElementById('contextEditBtn');
    const contextRenameBtn = document.getElementById('contextRenameBtn');
    const contextDeleteBtn = document.getElementById('contextDeleteBtn');
    const backToAlbumsBtn = document.getElementById('backToAlbumsBtn');
    const screenAlbumTitle = document.getElementById('screenAlbumTitle');
    const screenAlbumMeta = document.getElementById('screenAlbumMeta');
    const mainScreenTitle = document.getElementById('mainScreenTitle');
    const albumsView = document.getElementById('albumsView');
    const searchView = document.getElementById('searchView');
    const addView = document.getElementById('addView');
    const navAlbumsBtn = document.getElementById('navAlbumsBtn');
    const navAddBtn = document.getElementById('navAddBtn');
    const navSearchBtn = document.getElementById('navSearchBtn');
    const createAlbumBtn = document.getElementById('createAlbumBtn');

    const LONG_PRESS_MS = 500;
    const MOVE_TOLERANCE_PX = 12;

    let currentAlbumCard = null;
    let selectedColor = '#4f7cff';
    let isCustomColor = false;
    let contextAlbumCard = null;
    let openedAlbumCard = null;
    let activeView = 'albums';

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

    function normalizeHexColor(color) {
      return color.trim().toLowerCase();
    }

    function isPresetColor(color) {
      return presetColors.some(({ value }) => normalizeHexColor(value) === normalizeHexColor(color));
    }

    function updateSelectedColorPreview() {
      selectedColorDot.style.background = selectedColor;
      selectedColorText.textContent = isCustomColor
        ? `Colore personalizzato: ${selectedColor.toUpperCase()}`
        : `Colore selezionato: ${selectedColor.toUpperCase()}`;
    }

    function renderColorGrid(activeColor) {
      colorGrid.innerHTML = '';
      const normalizedActive = normalizeHexColor(activeColor);

      presetColors.forEach(({ label, value }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `color-option${normalizeHexColor(value) === normalizedActive ? ' selected' : ''}`;
        btn.style.background = value;
        btn.title = label;
        btn.setAttribute('aria-label', label);

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          selectedColor = value;
          isCustomColor = false;
          renderColorGrid(selectedColor);
        });

        colorGrid.appendChild(btn);
      });

      const customWrap = document.createElement('div');
      customWrap.className = `color-picker-trigger${isCustomColor ? ' selected' : ''}`;
      customWrap.title = 'Scegli un colore personalizzato';
      customWrap.setAttribute('aria-label', 'Apri tavolozza colori');
      customWrap.setAttribute('role', 'button');
      customWrap.tabIndex = 0;
      customWrap.innerHTML = `
        <span>+</span>
        <input class="hidden-color-input" type="color" value="${selectedColor}" />
      `;

      const colorInput = customWrap.querySelector('input');

      function applyCustomColor(value, finalRender = false) {
        selectedColor = value;
        isCustomColor = !isPresetColor(selectedColor);
        updateSelectedColorPreview();

        if (finalRender) {
          renderColorGrid(selectedColor);
        }
      }

      function triggerColorPicker(e) {
        e.preventDefault();
        e.stopPropagation();
        colorInput.click();
      }

      customWrap.addEventListener('click', triggerColorPicker);
      customWrap.addEventListener('pointerdown', (e) => e.stopPropagation());
      customWrap.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
      customWrap.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          triggerColorPicker(e);
        }
      });

      colorInput.addEventListener('click', (e) => e.stopPropagation());
      colorInput.addEventListener('pointerdown', (e) => e.stopPropagation());
      colorInput.addEventListener('input', (e) => {
        e.stopPropagation();
        applyCustomColor(e.target.value);
      });
      colorInput.addEventListener('change', (e) => {
        e.stopPropagation();
        applyCustomColor(e.target.value, true);
      });

      colorGrid.appendChild(customWrap);
      updateSelectedColorPreview();
    }

    function refreshOpenedAlbumScreen() {
      if (!openedAlbumCard) return;

      const { name, pages, slots } = openedAlbumCard.albumData;
      screenAlbumTitle.textContent = name;
      screenAlbumMeta.textContent = `${pages} pagine • ${pages * slots} slot totali`;
    }

    function openAlbumScreen(card) {
      openedAlbumCard = card;
      refreshOpenedAlbumScreen();
      mainApp.classList.add('hidden');
      albumScreen.classList.add('open');
    }

    function closeAlbumScreen() {
      openedAlbumCard = null;
      albumScreen.classList.remove('open');
      mainApp.classList.remove('hidden');
    }

    function openEditModal(card) {
      currentAlbumCard = card;
      const { name, pages, slots, color } = card.albumData;

      albumNameInput.value = name;
      albumPagesInput.value = pages;
      albumSlotsInput.value = slots;
      selectedColor = color;
      isCustomColor = !isPresetColor(selectedColor);
      renderColorGrid(selectedColor);
      editModalBackdrop.classList.add('open');
    }

    function closeEditModal() {
      editModalBackdrop.classList.remove('open');
      currentAlbumCard = null;
    }

    function openContextMenu(card) {
      contextAlbumCard = card;
      contextMenuTitle.textContent = card.albumData.name;
      contextMenuBackdrop.classList.add('open');
    }

    function closeContextMenu() {
      contextMenuBackdrop.classList.remove('open');
      contextAlbumCard = null;
    }

    function getSourceCard(card) {
      return card.sourceCard || card;
    }

    function renameAlbum(card) {
      const sourceCard = getSourceCard(card);
      const newName = window.prompt('Nuovo nome album', sourceCard.albumData.name);
      const trimmedName = newName?.trim();
      if (!trimmedName) return;

      sourceCard.albumData.name = trimmedName;
      updateAlbumCard(sourceCard);
      renderSearchResults(searchInput.value);
    }

    function deleteAlbum(card) {
      const sourceCard = getSourceCard(card);
      if (openedAlbumCard === sourceCard || openedAlbumCard === card) {
        closeAlbumScreen();
      }
      sourceCard.remove();
      renderSearchResults(searchInput.value);
    }

    function updateAlbumCard(card) {
      const sourceCard = getSourceCard(card);
      const { name, color, pages, slots } = sourceCard.albumData;
      sourceCard.querySelector('.book-icon').style.setProperty('--album-color', color);
      sourceCard.querySelector('.album-title').textContent = name;
      sourceCard.querySelector('.album-meta').textContent = `0/${pages * slots}`;
      refreshOpenedAlbumScreen();
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
        if (!pressTimer) return;
        clearTimeout(pressTimer);
        pressTimer = null;
      }

      function resetPressState() {
        clearPressTimer();
        pointerMoved = false;
        activePointerId = null;
      }

      function startPress(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        startX = e.clientX;
        startY = e.clientY;
        pointerMoved = false;
        longPressTriggered = false;
        activePointerId = e.pointerId;
        clearPressTimer();

        if (cover.setPointerCapture) {
          try {
            cover.setPointerCapture(e.pointerId);
          } catch (_) {}
        }

        pressTimer = setTimeout(() => {
          longPressTriggered = true;
          clearPressTimer();
          openContextMenu(card);
        }, LONG_PRESS_MS);
      }

      cover.addEventListener('pointerdown', startPress);

      cover.addEventListener('pointermove', (e) => {
        if (activePointerId !== e.pointerId || longPressTriggered) return;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;
        if (Math.hypot(deltaX, deltaY) <= MOVE_TOLERANCE_PX) return;

        pointerMoved = true;
        clearPressTimer();
      });

      cover.addEventListener('pointerup', (e) => {
        if (activePointerId !== e.pointerId) return;

        const shouldOpenAlbum = !longPressTriggered && !pointerMoved;

        if (cover.releasePointerCapture && cover.hasPointerCapture?.(e.pointerId)) {
          try {
            cover.releasePointerCapture(e.pointerId);
          } catch (_) {}
        }

        resetPressState();

        if (!shouldOpenAlbum) {
          e.preventDefault();
          return;
        }

        openAlbumScreen(card);
      });

      cover.addEventListener('pointercancel', (e) => {
        if (activePointerId === e.pointerId) {
          resetPressState();
        }
      });

      cover.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'mouse' && activePointerId === e.pointerId && !longPressTriggered) {
          resetPressState();
        }
      });

      cover.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    function getNextAlbumNumber() {
      const usedNumbers = Array.from(albumsRow.querySelectorAll('.album-card'))
        .map((card) => {
          const match = card.albumData.name.match(/^Album\s+(\d+)$/i);
          return match ? Number(match[1]) : null;
        })
        .filter((number) => Number.isInteger(number) && number > 0)
        .sort((a, b) => a - b);

      let nextNumber = 1;
      for (const number of usedNumbers) {
        if (number > nextNumber) break;
        if (number === nextNumber) nextNumber++;
      }

      return nextNumber;
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

      card.innerHTML = `
        <div class="album-cover">
          <div class="book-icon" style="--album-color:${card.albumData.color}"></div>
          <div class="album-info">
            <div class="album-title"></div>
            <div class="album-meta"></div>
          </div>
        </div>
      `;

      updateAlbumCard(card);
      attachAlbumInteractions(card);
      albumsRow.appendChild(card);
      renderSearchResults(searchInput.value);

      if (openEditor) {
        setActiveView('albums');
        openEditModal(card);
      }
    }

    function renderSearchResults(query = '') {
      const normalizedQuery = query.trim().toLowerCase();
      const cards = Array.from(albumsRow.querySelectorAll('.album-card'));

      searchResultsRow.innerHTML = '';

      const matches = cards.filter((card) => {
        if (!normalizedQuery) return true;
        const { name, pages, slots } = card.albumData;
        const searchableText = `${name} ${pages} ${slots}`.toLowerCase();
        return searchableText.includes(normalizedQuery);
      });

      matches.forEach((card) => {
        searchResultsRow.appendChild(card.cloneNode(true));
      });

      Array.from(searchResultsRow.children).forEach((clone, index) => {
        const originalCard = matches[index];
        clone.albumData = originalCard.albumData;
        clone.sourceCard = originalCard;
        attachAlbumInteractions(clone);
      });

      searchEmptyState.hidden = matches.length > 0;
    }

    function setActiveView(viewName) {
      activeView = viewName;
      albumsView.classList.toggle('active', viewName === 'albums');
      searchView.classList.toggle('active', viewName === 'search');
      addView.classList.toggle('active', viewName === 'add');

      navAlbumsBtn.classList.toggle('active', viewName === 'albums');
      navSearchBtn.classList.toggle('active', viewName === 'search');
      navAddBtn.classList.toggle('active', viewName === 'add');

      if (viewName === 'albums') {
        mainScreenTitle.textContent = 'Album';
      } else if (viewName === 'search') {
        mainScreenTitle.textContent = 'Cerca';
        renderSearchResults(searchInput.value);
      } else {
        mainScreenTitle.textContent = 'Aggiungi';
      }
    }

    backToAlbumsBtn.addEventListener('click', closeAlbumScreen);
    cancelEditBtn.addEventListener('click', closeEditModal);

    saveEditBtn.addEventListener('click', () => {
      if (!currentAlbumCard) return;

      currentAlbumCard.albumData.name = albumNameInput.value.trim() || currentAlbumCard.albumData.name;
      currentAlbumCard.albumData.color = selectedColor;
      currentAlbumCard.albumData.pages = Math.max(1, Number(albumPagesInput.value) || 1);
      currentAlbumCard.albumData.slots = Math.max(1, Number(albumSlotsInput.value) || 1);

      updateAlbumCard(currentAlbumCard);
      renderSearchResults(searchInput.value);
      closeEditModal();
    });

    contextEditBtn.addEventListener('click', () => {
      if (!contextAlbumCard) return;
      const targetCard = contextAlbumCard;
      closeContextMenu();
      openEditModal(targetCard);
    });

    contextRenameBtn.addEventListener('click', () => {
      if (!contextAlbumCard) return;
      const targetCard = contextAlbumCard;
      closeContextMenu();
      renameAlbum(targetCard);
    });

    contextDeleteBtn.addEventListener('click', () => {
      if (!contextAlbumCard) return;
      const targetCard = contextAlbumCard;
      closeContextMenu();
      deleteAlbum(targetCard);
    });

    editModalBackdrop.addEventListener('click', (e) => {
      if (e.target === editModalBackdrop) {
        closeEditModal();
      }
    });

    contextMenuBackdrop.addEventListener('click', (e) => {
      if (e.target === contextMenuBackdrop) {
        closeContextMenu();
      }
    });

    editModal.addEventListener('click', (e) => e.stopPropagation());
    contextMenu.addEventListener('click', (e) => e.stopPropagation());

    navAlbumsBtn.addEventListener('click', () => setActiveView('albums'));
    navSearchBtn.addEventListener('click', () => setActiveView('search'));
    navAddBtn.addEventListener('click', () => {
      createAlbum(false);
      setActiveView('albums');
    });
    createAlbumBtn.addEventListener('click', () => createAlbum(false));
    searchInput.addEventListener('input', (e) => renderSearchResults(e.target.value));

    createAlbum();
    createAlbum();
    createAlbum();
    renderSearchResults();