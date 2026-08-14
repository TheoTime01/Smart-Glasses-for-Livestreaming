/*
 * Meta Ray-Ban Display live viewer — M2 shell.
 *
 * Input is D-pad only: ArrowUp/Down/Left/Right, Enter, Escape. There is no
 * pointer, no keyboard and no text composer we can rely on, so pairing uses a
 * digit picker rather than an input field.
 *
 * The video player itself arrives in M3/M4; this file already picks which
 * playback strategy the runtime can support so the choice is testable now.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'mrbd.device_token';
  var STRATEGY_KEY = 'mrbd.player_strategy';
  var ROW_HEIGHT = 104; // .stream-row height (96) + flex gap (8)

  var state = {
    screen: 'pair',
    digits: [0, 0, 0, 0, 0, 0],
    streams: [],
    /** Index into state.streams, NOT into the visible page. The page is derived
     *  from it, so a resize that changes how many rows fit keeps the wearer on
     *  the same stream instead of jumping. */
    selected: 0,
    page: 0,
    current: null,
  };

  var screens = {
    pair: document.getElementById('screen-pair'),
    list: document.getElementById('screen-list'),
    viewer: document.getElementById('screen-viewer'),
    error: document.getElementById('screen-error'),
  };

  var els = {
    pairStatus: document.getElementById('pair-status'),
    digits: document.getElementById('digits'),
    listStatus: document.getElementById('list-status'),
    streamList: document.getElementById('stream-list'),
    listPager: document.getElementById('list-pager'),
    viewerName: document.getElementById('viewer-name'),
    viewerStatus: document.getElementById('viewer-status'),
    viewerNote: document.getElementById('viewer-note'),
    errorText: document.getElementById('error-text'),
  };

  /* ------------------------------------------------------ player strategy */

  /**
   * Which playback path this runtime can support. Exposed on window so the
   * Playwright suite can stub MediaSource away and assert the fallback.
   * Order matches the spec: native/MSE HLS, then the frame relay, then polling.
   */
  function selectPlayerStrategy() {
    var params = new URLSearchParams(location.search);
    var forced = params.get('player') || localStorage.getItem(STRATEGY_KEY);
    if (forced === 'hls' || forced === 'relay' || forced === 'poll') {
      localStorage.setItem(STRATEGY_KEY, forced);
      return { strategy: forced, reason: 'forced by ?player= or stored preference' };
    }

    var video = document.createElement('video');
    var nativeHls =
      typeof video.canPlayType === 'function' &&
      video.canPlayType('application/vnd.apple.mpegurl') !== '';
    if (nativeHls) return { strategy: 'hls', reason: 'native HLS playback' };

    var mse =
      typeof window.MediaSource !== 'undefined' &&
      typeof window.MediaSource.isTypeSupported === 'function' &&
      window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
    if (mse) return { strategy: 'hls', reason: 'MSE (hls.js) available' };

    var canRender =
      typeof createImageBitmap === 'function' ||
      (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function');
    if (typeof WebSocket !== 'undefined' && canRender) {
      return { strategy: 'relay', reason: 'no MSE and no native HLS — using the frame relay' };
    }

    return { strategy: 'poll', reason: 'no MSE, no HLS, no usable WebSocket — polling JPEGs' };
  }

  window.__selectPlayerStrategy = selectPlayerStrategy;

  /* ------------------------------------------------------------- plumbing */

  function token() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  }

  function setToken(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage disabled — the session still works, it just will not persist */
    }
  }

  function api(path, options) {
    var init = Object.assign({ headers: {} }, options || {});
    if (token()) init.headers.authorization = 'Bearer ' + token();

    return fetch(path, init).then(function (response) {
      if (response.status === 204) return null;
      return response.json().then(
        function (body) {
          if (!response.ok) {
            var error = new Error((body && body.message) || 'HTTP ' + response.status);
            error.status = response.status;
            error.code = body && body.error;
            throw error;
          }
          return body;
        },
        function () {
          throw new Error('HTTP ' + response.status);
        },
      );
    });
  }

  function show(name) {
    state.screen = name;
    Object.keys(screens).forEach(function (key) {
      screens[key].classList.toggle('hidden', key !== name);
    });
    var first = focusables()[0];
    if (first) {
      first.focus();
    } else if (document.activeElement && typeof document.activeElement.blur === 'function') {
      // Nothing to focus yet (an empty list). Drop focus rather than leave it
      // on a control of the screen we just hid.
      document.activeElement.blur();
    }
  }

  /** Focusable elements of the active screen, in DOM order. */
  function focusables() {
    var screen = screens[state.screen];
    if (!screen) return [];
    return Array.prototype.slice.call(screen.querySelectorAll('.focusable'));
  }

  function moveFocus(step) {
    var items = focusables();
    if (items.length === 0) return;
    var index = items.indexOf(document.activeElement);
    index = index === -1 ? 0 : (index + step + items.length) % items.length;
    items[index].focus();
  }

  function showError(message) {
    els.errorText.textContent = message;
    show('error');
  }

  /* ----------------------------------------------------------------- pair */

  function renderDigits() {
    var buttons = els.digits.querySelectorAll('.digit');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].textContent = String(state.digits[i]);
    }
  }

  function activeDigitIndex() {
    var active = document.activeElement;
    if (!active || !active.classList || !active.classList.contains('digit')) return -1;
    return Number(active.dataset.index);
  }

  function bumpDigit(delta) {
    var index = activeDigitIndex();
    if (index < 0) return;
    state.digits[index] = (state.digits[index] + delta + 10) % 10;
    renderDigits();
  }

  function submitCode() {
    var code = state.digits.join('');
    els.pairStatus.textContent = 'Pairing…';

    api('/api/pair/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code, deviceName: 'Ray-Ban Display' }),
    })
      .then(function (result) {
        setToken(result.token);
        els.pairStatus.textContent = 'Paired';
        loadStreams();
      })
      .catch(function (error) {
        els.pairStatus.textContent = error.message + ' — try again';
      });
  }

  /* ----------------------------------------------------------------- list */

  function rowsPerPage() {
    var height = els.streamList.clientHeight;
    return Math.max(1, Math.floor(height / ROW_HEIGHT));
  }

  function pageCount() {
    return Math.max(1, Math.ceil(state.streams.length / rowsPerPage()));
  }

  function renderList() {
    var perPage = rowsPerPage();

    if (state.selected > state.streams.length - 1) state.selected = state.streams.length - 1;
    if (state.selected < 0) state.selected = 0;

    // The page follows the selection, so it can never point somewhere the
    // selected stream is not.
    state.page = Math.min(Math.floor(state.selected / perPage), pageCount() - 1);

    var start = state.page * perPage;
    var visible = state.streams.slice(start, start + perPage);

    els.streamList.textContent = '';

    if (state.streams.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No streams yet. Create one on the control page.';
      els.streamList.appendChild(empty);
      els.listPager.textContent = '';
      return;
    }

    visible.forEach(function (stream, offset) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'focusable stream-row' + (stream.broadcasting ? ' live' : '');
      row.dataset.streamId = stream.id;

      var dot = document.createElement('span');
      dot.className = 'dot';

      var text = document.createElement('span');
      text.className = 'text';

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = stream.name;

      var stateLine = document.createElement('span');
      stateLine.className = 'state';
      // Never colour-only: the dot is paired with a word.
      stateLine.textContent = stream.broadcasting ? 'live now' : 'offline';

      text.appendChild(name);
      text.appendChild(stateLine);
      row.appendChild(dot);
      row.appendChild(text);
      row.addEventListener('click', function () {
        openViewer(stream);
      });
      els.streamList.appendChild(row);

      if (offset === 0) row.dataset.first = 'true';
    });


    els.listPager.textContent =
      state.streams.length <= perPage
        ? state.streams.length + ' stream' + (state.streams.length === 1 ? '' : 's')
        : start + 1 + '–' + Math.min(start + perPage, state.streams.length) + ' of ' + state.streams.length;

    var rows = els.streamList.querySelectorAll('.stream-row');
    var target = rows[state.selected - start];
    if (target && state.screen === 'list') target.focus();
  }

  function loadStreams() {
    show('list');
    els.listStatus.textContent = 'loading…';

    api('/api/glasses/streams')
      .then(function (data) {
        state.streams = data.streams;
        state.selected = 0;
        els.listStatus.textContent = data.streams.length === 0 ? 'nothing to watch yet' : 'Enter to watch';
        renderList();
      })
      .catch(function (error) {
        if (error.status === 401) {
          setToken('');
          els.pairStatus.textContent = 'Pairing expired. Enter a new code.';
          show('pair');
          return;
        }
        showError(error.message);
      });
  }

  /* --------------------------------------------------------------- viewer */

  function openViewer(stream) {
    state.current = stream;
    els.viewerName.textContent = stream.name;
    els.viewerStatus.textContent = stream.broadcasting ? 'live now' : 'offline — nothing is broadcasting';
    show('viewer');

    var choice = selectPlayerStrategy();
    els.viewerNote.dataset.strategy = choice.strategy;
    els.viewerNote.textContent =
      'Playback path: ' + choice.strategy.toUpperCase() + '\n' + choice.reason + '\n\nThe player lands in M3.';

    // Confirms the token still works and the URL resolves, without playing it.
    api('/api/glasses/streams/' + encodeURIComponent(stream.id) + '/playback')
      .then(function (playback) {
        els.viewerStatus.textContent = playback.broadcasting
          ? 'live now · playback URL ready'
          : 'offline — the playback URL appears once broadcasting starts';
      })
      .catch(function (error) {
        els.viewerStatus.textContent = 'playback unavailable: ' + error.message;
      });
  }

  /* ---------------------------------------------------------------- input */

  var ACTIONS = {
    'pair-submit': submitCode,
    'viewer-back': loadStreams,
    'error-retry': function () {
      if (token()) loadStreams();
      else show('pair');
    },
    'error-unpair': function () {
      setToken('');
      els.pairStatus.textContent = 'Unpaired. Enter a new code.';
      show('pair');
    },
  };

  function activate(element) {
    if (!element) return;
    if (element.classList.contains('digit')) return submitCode();
    if (element.classList.contains('stream-row')) {
      var stream = state.streams.filter(function (candidate) {
        return candidate.id === element.dataset.streamId;
      })[0];
      if (stream) openViewer(stream);
      return;
    }
    var action = element.getAttribute('data-action');
    if (action && ACTIONS[action]) ACTIONS[action]();
  }

  document.addEventListener('keydown', function (event) {
    var key = event.key;
    if (
      key !== 'ArrowUp' &&
      key !== 'ArrowDown' &&
      key !== 'ArrowLeft' &&
      key !== 'ArrowRight' &&
      key !== 'Enter' &&
      key !== 'Escape'
    ) {
      return;
    }
    event.preventDefault();

    if (key === 'Enter') return activate(document.activeElement);

    if (key === 'Escape') {
      if (state.screen === 'viewer') loadStreams();
      else if (state.screen === 'error' && token()) loadStreams();
      return;
    }

    if (state.screen === 'pair') {
      // Left/Right picks the position, Up/Down changes the value.
      if (key === 'ArrowLeft') moveFocus(-1);
      else if (key === 'ArrowRight') moveFocus(1);
      else bumpDigit(key === 'ArrowUp' ? 1 : -1);
      return;
    }

    if (state.screen === 'list') {
      if (state.streams.length === 0) return;

      if (key === 'ArrowUp' || key === 'ArrowDown') {
        // Walks the whole list, not just the visible page: stepping off the
        // bottom row turns the page instead of wrapping back to the top of it.
        var step = key === 'ArrowDown' ? 1 : -1;
        state.selected = (state.selected + step + state.streams.length) % state.streams.length;
      } else {
        // No scrolling anywhere: overflow becomes pages.
        var perPage = rowsPerPage();
        var pages = pageCount();
        var page = state.page + (key === 'ArrowLeft' ? -1 : 1);
        if (page < 0) page = pages - 1;
        if (page > pages - 1) page = 0;
        state.selected = Math.min(page * perPage, state.streams.length - 1);
      }
      renderList();
      return;
    }

    moveFocus(key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1);
  });

  window.addEventListener('resize', function () {
    if (state.screen === 'list') renderList();
  });

  /* ------------------------------------------------------------- start-up */

  renderDigits();

  if (token()) {
    loadStreams();
  } else {
    show('pair');
  }
})();
