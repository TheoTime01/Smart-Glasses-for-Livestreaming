/*
 * Milestone 0 — capability probe.
 *
 * Video playback is not in the documented Meta Ray-Ban Display Web App
 * capability table, so this page assumes nothing: it measures what the runtime
 * actually does, renders the result on the HUD, and POSTs it to /api/probe.
 *
 * Vanilla JS on purpose — no bundler, no framework, no dependency downloads.
 */
(function () {
  'use strict';

  var VIDEO_TIMEOUT_MS = 10000;
  var WS_TIMEOUT_MS = 8000;
  var IMAGE_TIMEOUT_MS = 5000;
  var ROW_HEIGHT = 70; // .row height (66) + flex gap (4)

  var elements = {
    status: document.getElementById('status'),
    list: document.getElementById('list'),
    pager: document.getElementById('pager'),
    rerun: document.getElementById('btn-rerun'),
    send: document.getElementById('btn-send'),
    video: document.getElementById('probe-video'),
    canvas: document.getElementById('probe-canvas'),
    img: document.getElementById('probe-img'),
  };

  var state = {
    checks: [],
    page: 0,
    running: false,
    samples: {},
    lastReportId: null,
  };

  /* ---------------------------------------------------------------- utils */

  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function setStatus(text) {
    elements.status.textContent = text;
  }

  function push(check) {
    state.checks.push(check);
    render();
  }

  function describeMediaError(error) {
    if (!error) return 'no MediaError';
    var names = {
      1: 'MEDIA_ERR_ABORTED',
      2: 'MEDIA_ERR_NETWORK',
      3: 'MEDIA_ERR_DECODE',
      4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
    };
    var name = names[error.code] || 'code ' + error.code;
    return error.message ? name + ': ' + error.message : name;
  }

  function errorText(error) {
    if (!error) return 'unknown error';
    return (error.name ? error.name + ': ' : '') + (error.message || String(error));
  }

  /* --------------------------------------------------------------- render */

  function render() {
    var rowsPerPage = Math.max(1, Math.floor(elements.list.clientHeight / ROW_HEIGHT));
    var pageCount = Math.max(1, Math.ceil(state.checks.length / rowsPerPage));
    if (state.page > pageCount - 1) state.page = pageCount - 1;
    if (state.page < 0) state.page = 0;

    var start = state.page * rowsPerPage;
    var visible = state.checks.slice(start, start + rowsPerPage);

    elements.list.textContent = '';
    for (var i = 0; i < visible.length; i += 1) {
      elements.list.appendChild(rowFor(visible[i]));
    }

    elements.pager.textContent =
      'page ' + (state.page + 1) + ' of ' + pageCount + ' · ' + state.checks.length + ' checks';
  }

  function rowFor(check) {
    var row = document.createElement('div');
    row.className = 'row ' + (check.ok === true ? 'pass' : check.ok === false ? 'fail' : 'info');

    var mark = document.createElement('div');
    mark.className = 'mark';
    mark.textContent = check.ok === true ? '✓' : check.ok === false ? '✗' : '•';

    var text = document.createElement('div');
    text.className = 'text';

    var label = document.createElement('div');
    label.className = 'label';
    label.textContent = check.label;

    var detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = check.detail + (check.ms != null ? '  (' + Math.round(check.ms) + 'ms)' : '');

    text.appendChild(label);
    text.appendChild(detail);
    row.appendChild(mark);
    row.appendChild(text);
    return row;
  }

  /* --------------------------------------------------------------- checks */

  function checkMediaSource() {
    var available = typeof window.MediaSource !== 'undefined' && !!window.MediaSource;
    push({
      id: 'mse.available',
      label: 'MediaSource available',
      ok: available,
      detail: available ? 'window.MediaSource is present' : 'window.MediaSource is undefined',
    });

    var mime = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
    if (!available || typeof window.MediaSource.isTypeSupported !== 'function') {
      push({
        id: 'mse.h264.aac',
        label: 'MSE H.264 + AAC',
        ok: null,
        detail: 'isTypeSupported unavailable — cannot test',
      });
      return;
    }
    var supported = false;
    var detail;
    try {
      supported = window.MediaSource.isTypeSupported(mime);
      detail = mime + ' → ' + supported;
    } catch (error) {
      detail = 'isTypeSupported threw: ' + errorText(error);
    }
    push({ id: 'mse.h264.aac', label: 'MSE H.264 + AAC', ok: supported, detail: detail });
  }

  function checkCanPlayType() {
    var video = document.createElement('video');
    if (typeof video.canPlayType !== 'function') {
      push({
        id: 'video.canplaytype',
        label: 'video.canPlayType',
        ok: false,
        detail: 'canPlayType is not a function',
      });
      return;
    }

    var hls = video.canPlayType('application/vnd.apple.mpegurl');
    push({
      id: 'video.canplaytype.hls',
      label: 'Native HLS (canPlayType)',
      ok: hls === 'probably' || hls === 'maybe',
      detail: 'application/vnd.apple.mpegurl → "' + hls + '"',
    });

    var mp4 = video.canPlayType('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
    push({
      id: 'video.canplaytype.mp4',
      label: 'MP4 H.264 (canPlayType)',
      ok: mp4 === 'probably' || mp4 === 'maybe',
      detail: 'video/mp4 avc1.42E01E → "' + mp4 + '"',
    });
  }

  /**
   * Loads `url` into the shared <video> and reports whether loadedmetadata and
   * playing ever fire. Bounded by VIDEO_TIMEOUT_MS so a dead URL cannot hang
   * the run.
   */
  function checkVideoPlayback(kind, url) {
    var video = elements.video;
    var started = now();
    var metadataAt = null;
    var metadataDetail = '';
    var playingAt = null;
    var playRejection = '';
    var outcome = '';

    video.muted = true;
    video.setAttribute('playsinline', '');
    video.autoplay = true;

    return new Promise(function (resolve) {
      var settled = false;
      var timer = null;

      function cleanup() {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', onMetadata);
        video.removeEventListener('playing', onPlaying);
        video.removeEventListener('error', onError);
        try {
          video.pause();
        } catch {
          /* pausing a never-started element can throw; nothing to do */
        }
        video.removeAttribute('src');
        video.load();
      }

      function finish(reason) {
        if (settled) return;
        settled = true;
        outcome = reason;
        cleanup();
        resolve();
      }

      function onMetadata() {
        metadataAt = now();
        // Snapshot now: cleanup() resets the element, which zeroes these.
        metadataDetail =
          video.videoWidth +
          'x' +
          video.videoHeight +
          ', duration ' +
          (isFinite(video.duration) ? video.duration.toFixed(1) + 's' : String(video.duration)) +
          ', readyState ' +
          video.readyState;
      }

      function onPlaying() {
        playingAt = now();
        finish('playing');
      }

      function onError() {
        finish('error: ' + describeMediaError(video.error));
      }

      video.addEventListener('loadedmetadata', onMetadata);
      video.addEventListener('playing', onPlaying);
      video.addEventListener('error', onError);

      timer = setTimeout(function () {
        finish('timeout after ' + VIDEO_TIMEOUT_MS + 'ms');
      }, VIDEO_TIMEOUT_MS);

      video.src = url;
      try {
        video.load();
        var attempt = video.play();
        if (attempt && typeof attempt.catch === 'function') {
          attempt.catch(function (error) {
            playRejection = errorText(error);
          });
        }
      } catch (error) {
        playRejection = errorText(error);
      }
    }).then(function () {
      push({
        id: 'video.' + kind + '.loadedmetadata',
        label: kind.toUpperCase() + ' loadedmetadata',
        ok: metadataAt !== null,
        detail: metadataAt !== null ? metadataDetail : outcome,
        ms: (metadataAt || now()) - started,
      });

      push({
        id: 'video.' + kind + '.playing',
        label: kind.toUpperCase() + ' playing',
        ok: playingAt !== null,
        detail:
          playingAt !== null
            ? 'frames started'
            : outcome + (playRejection ? ' · play() rejected: ' + playRejection : ''),
        ms: (playingAt || now()) - started,
      });
    });
  }

  function checkWebSocket() {
    var started = now();
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/probe';

    if (typeof WebSocket === 'undefined') {
      push({ id: 'ws.connect', label: 'WebSocket connect', ok: false, detail: 'WebSocket is undefined' });
      push({ id: 'ws.binary', label: 'WebSocket binary frame', ok: null, detail: 'skipped' });
      return Promise.resolve();
    }

    return new Promise(function (resolve) {
      var settled = false;
      var opened = false;
      var openedAt = null;
      var binaryDetail = 'no binary frame received';
      var binaryOk = false;
      var failure = '';
      var socket;

      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (socket) socket.close();
        } catch {
          /* already closing */
        }
        push({
          id: 'ws.connect',
          label: 'WebSocket connect',
          ok: opened,
          detail: opened ? 'open to ' + url : failure || 'never opened',
          ms: (openedAt || now()) - started,
        });
        push({
          id: 'ws.binary',
          label: 'WebSocket binary frame',
          ok: opened ? binaryOk : null,
          detail: opened ? binaryDetail : 'skipped — never connected',
        });
        resolve();
      }

      function verify(buffer) {
        var bytes = new Uint8Array(buffer);
        var intact = bytes.length === 1024;
        for (var i = 0; intact && i < bytes.length; i += 1) {
          if (bytes[i] !== i % 256) intact = false;
        }
        binaryOk = intact;
        binaryDetail = intact
          ? bytes.length + ' bytes received, pattern intact'
          : bytes.length + ' bytes received, pattern corrupt';
        finish();
      }

      var timer = setTimeout(function () {
        failure = failure || 'timeout after ' + WS_TIMEOUT_MS + 'ms';
        finish();
      }, WS_TIMEOUT_MS);

      try {
        socket = new WebSocket(url);
      } catch (error) {
        failure = errorText(error);
        finish();
        return;
      }

      socket.binaryType = 'arraybuffer';

      socket.onopen = function () {
        opened = true;
        openedAt = now();
        socket.send('ping');
      };

      socket.onmessage = function (event) {
        if (typeof event.data === 'string') return; // "pong" — connectivity only
        if (event.data instanceof ArrayBuffer) {
          verify(event.data);
        } else if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
          // binaryType='arraybuffer' was ignored; the relay client will need
          // the Blob path, so record that.
          if (typeof event.data.arrayBuffer === 'function') {
            event.data.arrayBuffer().then(verify);
          } else {
            binaryDetail = 'received Blob, no arrayBuffer() available';
            finish();
          }
        } else {
          binaryDetail = 'unexpected message type: ' + typeof event.data;
          finish();
        }
      };

      socket.onerror = function () {
        failure = 'socket error';
        if (!opened) finish();
      };

      socket.onclose = function (event) {
        if (!opened) {
          failure = 'closed before open (code ' + event.code + ')';
          finish();
        }
      };
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve) {
      var image = elements.img;
      var timer = setTimeout(function () {
        resolve({ ok: false, detail: 'timeout after ' + IMAGE_TIMEOUT_MS + 'ms' });
      }, IMAGE_TIMEOUT_MS);

      image.onload = function () {
        clearTimeout(timer);
        resolve({ ok: true, detail: image.naturalWidth + 'x' + image.naturalHeight });
      };
      image.onerror = function () {
        clearTimeout(timer);
        resolve({ ok: false, detail: 'img error event' });
      };
      image.src = src;
    });
  }

  /**
   * Blob -> object URL -> <img>, canvas drawImage, and createImageBitmap: the
   * three primitives the Path B frame relay would render with.
   */
  function checkBlobAndCanvas() {
    var blob = null;
    var objectUrl = null;

    return fetch('/probe/dot.png')
      .then(function (response) {
        return response.arrayBuffer();
      })
      .then(function (buffer) {
        blob = new Blob([buffer], { type: 'image/png' });
        if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
          push({
            id: 'blob.objecturl',
            label: 'Blob object URL on <img>',
            ok: false,
            detail: 'URL.createObjectURL is unavailable',
          });
          return null;
        }
        objectUrl = URL.createObjectURL(blob);
        var started = now();
        return loadImage(objectUrl).then(function (result) {
          push({
            id: 'blob.objecturl',
            label: 'Blob object URL on <img>',
            ok: result.ok,
            detail: result.ok ? 'decoded ' + result.detail : result.detail,
            ms: now() - started,
          });
          return result.ok;
        });
      })
      .then(function (imageOk) {
        // Canvas drawImage of the just-decoded <img>, verified by reading a pixel.
        var context = elements.canvas.getContext('2d');
        if (!context) {
          push({ id: 'canvas.drawimage', label: 'Canvas drawImage', ok: false, detail: 'no 2d context' });
        } else if (!imageOk) {
          push({ id: 'canvas.drawimage', label: 'Canvas drawImage', ok: null, detail: 'skipped — no image' });
        } else {
          try {
            context.clearRect(0, 0, 64, 64);
            context.drawImage(elements.img, 0, 0, 64, 64);
            var pixel = context.getImageData(32, 32, 1, 1).data;
            var drew = pixel[3] !== 0 && (pixel[0] !== 0 || pixel[1] !== 0 || pixel[2] !== 0);
            push({
              id: 'canvas.drawimage',
              label: 'Canvas drawImage',
              ok: drew,
              detail: 'centre pixel rgba(' + pixel[0] + ',' + pixel[1] + ',' + pixel[2] + ',' + pixel[3] + ')',
            });
          } catch (error) {
            push({
              id: 'canvas.drawimage',
              label: 'Canvas drawImage',
              ok: false,
              detail: errorText(error),
            });
          }
        }

        if (objectUrl) URL.revokeObjectURL(objectUrl); // never leak object URLs

        if (typeof createImageBitmap !== 'function' || !blob) {
          push({
            id: 'createimagebitmap',
            label: 'createImageBitmap',
            ok: false,
            detail: 'createImageBitmap is not a function',
          });
          return null;
        }

        var started = now();
        return createImageBitmap(blob).then(
          function (bitmap) {
            var context2 = elements.canvas.getContext('2d');
            var detail = bitmap.width + 'x' + bitmap.height;
            if (context2) {
              context2.clearRect(0, 0, 64, 64);
              context2.drawImage(bitmap, 0, 0);
              detail += ', drawn to canvas';
            }
            if (typeof bitmap.close === 'function') bitmap.close();
            push({
              id: 'createimagebitmap',
              label: 'createImageBitmap',
              ok: true,
              detail: detail,
              ms: now() - started,
            });
          },
          function (error) {
            push({
              id: 'createimagebitmap',
              label: 'createImageBitmap',
              ok: false,
              detail: errorText(error),
              ms: now() - started,
            });
          },
        );
      })
      .catch(function (error) {
        push({
          id: 'blob.objecturl',
          label: 'Blob object URL on <img>',
          ok: false,
          detail: 'sample image fetch failed: ' + errorText(error),
        });
      });
  }

  function checkFetchStream() {
    var started = now();
    return fetch('/api/probe/stream-test')
      .then(function (response) {
        if (!response.body || typeof response.body.getReader !== 'function') {
          push({
            id: 'fetch.readablestream',
            label: 'fetch ReadableStream body',
            ok: false,
            detail: 'response.body has no getReader()',
          });
          return null;
        }

        var reader = response.body.getReader();
        var chunks = 0;
        var bytes = 0;
        var firstChunkAt = null;

        function pump() {
          return reader.read().then(function (result) {
            if (result.done) return null;
            chunks += 1;
            bytes += result.value ? result.value.length : 0;
            if (firstChunkAt === null) firstChunkAt = now();
            return pump();
          });
        }

        return pump().then(function () {
          // 3 chunks arrive with gaps server-side; a runtime that buffers the
          // whole response delivers 1. Both are usable, but only the first is
          // real streaming, which matters for the Path B relay.
          push({
            id: 'fetch.readablestream',
            label: 'fetch ReadableStream body',
            ok: chunks > 0,
            detail:
              chunks +
              ' chunk(s), ' +
              bytes +
              ' bytes, ' +
              (chunks > 1 ? 'incremental' : 'buffered as one chunk'),
            ms: now() - started,
          });
        });
      })
      .catch(function (error) {
        push({
          id: 'fetch.readablestream',
          label: 'fetch ReadableStream body',
          ok: false,
          detail: errorText(error),
        });
      });
  }

  /* Not in the M0 list, but one line each and they decide M5 (offline shell)
     and the M2 device-token storage. */
  function checkStorage() {
    var storageOk = false;
    var storageDetail;
    try {
      window.localStorage.setItem('mrbd.probe', '1');
      storageOk = window.localStorage.getItem('mrbd.probe') === '1';
      window.localStorage.removeItem('mrbd.probe');
      storageDetail = storageOk ? 'read/write round trip ok' : 'value did not persist';
    } catch (error) {
      storageDetail = errorText(error);
    }
    push({ id: 'storage.local', label: 'localStorage', ok: storageOk, detail: storageDetail });

    var swAvailable = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
    push({
      id: 'serviceworker.available',
      label: 'Service Worker API',
      ok: swAvailable,
      detail: swAvailable ? 'navigator.serviceWorker present' : 'not exposed',
    });
  }

  function environment() {
    return {
      userAgent: navigator.userAgent || '',
      devicePixelRatio: typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : null,
      screenWidth: window.screen ? window.screen.width : null,
      screenHeight: window.screen ? window.screen.height : null,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  }

  function pushEnvironmentRows() {
    var env = environment();
    push({ id: 'env.viewport', label: 'window inner size', ok: null, detail: env.innerWidth + 'x' + env.innerHeight });
    push({
      id: 'env.screen',
      label: 'screen size / DPR',
      ok: null,
      detail: env.screenWidth + 'x' + env.screenHeight + ' @ ' + env.devicePixelRatio,
    });
    push({ id: 'env.useragent', label: 'user agent', ok: null, detail: env.userAgent });
  }

  /* ------------------------------------------------------------------ run */

  function loadProbeConfig() {
    return fetch('/api/probe/config')
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        state.samples = data.samples || {};
      })
      .catch(function (error) {
        setStatus('config fetch failed: ' + errorText(error));
        state.samples = {};
      });
  }

  function run() {
    if (state.running) return Promise.resolve();
    state.running = true;
    state.checks = [];
    state.page = 0;
    state.lastReportId = null;
    render();

    setStatus('loading probe config…');

    return loadProbeConfig()
      .then(function () {
        setStatus('checking media APIs…');
        checkMediaSource();
        checkCanPlayType();

        setStatus('testing MP4 playback (up to 10s)…');
        return state.samples.mp4 ? checkVideoPlayback('mp4', state.samples.mp4) : null;
      })
      .then(function () {
        setStatus('testing HLS playback (up to 10s)…');
        return state.samples.hls ? checkVideoPlayback('hls', state.samples.hls) : null;
      })
      .then(function () {
        setStatus('testing WebSocket…');
        return checkWebSocket();
      })
      .then(function () {
        setStatus('testing blob / canvas…');
        return checkBlobAndCanvas();
      })
      .then(function () {
        setStatus('testing streaming fetch…');
        return checkFetchStream();
      })
      .then(function () {
        checkStorage();
        pushEnvironmentRows();
        state.running = false;
        var failed = state.checks.filter(function (check) {
          return check.ok === false;
        }).length;
        setStatus(failed === 0 ? 'all checks passed — sending…' : failed + ' check(s) failed — sending…');
        return send();
      })
      .catch(function (error) {
        state.running = false;
        setStatus('probe failed: ' + errorText(error));
      });
  }

  function send() {
    if (state.checks.length === 0) {
      setStatus('nothing to send yet');
      return Promise.resolve();
    }

    var params = new URLSearchParams(location.search);
    var body = {
      clientTime: new Date().toISOString(),
      environment: environment(),
      checks: state.checks,
      samples: state.samples,
    };
    var tag = params.get('tag');
    if (tag) body.tag = tag;

    return fetch('/api/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        state.lastReportId = data.id;
        setStatus('sent ✓ report ' + String(data.id).slice(0, 8));
      })
      .catch(function (error) {
        setStatus('send failed: ' + errorText(error) + ' — read results on screen');
      });
  }

  /* ---------------------------------------------------------------- input */

  var focusables = [elements.rerun, elements.send];

  function moveFocus(step) {
    var index = focusables.indexOf(document.activeElement);
    if (index === -1) index = 0;
    else index = (index + step + focusables.length) % focusables.length;
    focusables[index].focus();
  }

  document.addEventListener('keydown', function (event) {
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        state.page -= 1;
        render();
        break;
      case 'ArrowRight':
        event.preventDefault();
        state.page += 1;
        render();
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(-1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(1);
        break;
      case 'Enter':
        event.preventDefault();
        activate(document.activeElement);
        break;
      case 'Escape':
        event.preventDefault();
        state.page = 0;
        render();
        break;
      default:
        break;
    }
  });

  function activate(element) {
    if (!element) return;
    var action = element.getAttribute && element.getAttribute('data-action');
    if (action === 'rerun') run();
    else if (action === 'send') send();
  }

  elements.rerun.addEventListener('click', function () {
    run();
  });
  elements.send.addEventListener('click', function () {
    send();
  });

  window.addEventListener('resize', render);

  elements.rerun.focus();
  run();
})();
