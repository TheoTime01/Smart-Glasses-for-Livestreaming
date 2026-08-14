/*
 * Control page: create/stop api.video live streams and copy their RTMP
 * credentials. Runs in a normal browser, so modern JS is fine here (unlike the
 * glasses pages).
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'mrbd.control_token';

  var els = {
    envLine: document.getElementById('env-line'),
    pairButton: document.getElementById('pair-button'),
    pairStatus: document.getElementById('pair-status'),
    pairCode: document.getElementById('pair-code'),
    devices: document.getElementById('devices'),
    form: document.getElementById('create-form'),
    name: document.getElementById('create-name'),
    isPublic: document.getElementById('create-public'),
    submit: document.getElementById('create-submit'),
    refresh: document.getElementById('refresh'),
    status: document.getElementById('status'),
    streams: document.getElementById('streams'),
    template: document.getElementById('stream-template'),
  };

  function setStatus(text, isError) {
    els.status.textContent = text;
    els.status.classList.toggle('error', Boolean(isError));
  }

  function token() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  /** Adds the control token when one is stored, and turns 401 into a prompt. */
  async function api(path, options) {
    var init = Object.assign({ headers: {} }, options || {});
    if (token()) init.headers['x-control-token'] = token();

    var response = await fetch(path, init);

    if (response.status === 401) {
      var entered = window.prompt('This server requires a control token (CONTROL_TOKEN):', '');
      if (entered) {
        localStorage.setItem(TOKEN_KEY, entered.trim());
        return api(path, options);
      }
      throw new Error('A control token is required.');
    }

    if (response.status === 204) return null;

    var body = await response.json().catch(function () {
      return null;
    });

    if (!response.ok) {
      var message = (body && (body.message || body.error)) || 'HTTP ' + response.status;
      if (body && body.detail) message += ' — ' + body.detail;
      throw new Error(message);
    }
    return body;
  }

  function formatDate(iso) {
    if (!iso) return 'unknown';
    var date = new Date(iso);
    return isNaN(date.getTime()) ? iso : date.toLocaleString();
  }

  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API needs a secure context; fall back to a selection prompt.
      window.prompt('Copy manually:', text);
      return;
    }
    var original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(function () {
      button.textContent = original;
    }, 1200);
  }

  function renderStream(stream) {
    var node = els.template.content.firstElementChild.cloneNode(true);
    var q = function (selector) {
      return node.querySelector(selector);
    };

    q('.stream-name').textContent = stream.name;
    q('.stream-id').textContent = stream.id;
    q('.created').textContent = formatDate(stream.createdAt);

    var visibility = q('.visibility');
    visibility.textContent = stream.public ? 'public' : 'private';
    visibility.classList.toggle('private', !stream.public);

    setLiveState(node, stream.broadcasting);

    var values = {
      'rtmp-server': stream.ingest.rtmp.server,
      'stream-key': stream.ingest.streamKey,
      'rtmp-url': stream.ingest.rtmp.url,
      'rtmps-url': stream.ingest.rtmps.url,
      'srt-url': stream.ingest.srt.url,
      hls: stream.hls || '(no HLS URL yet)',
    };

    Object.keys(values).forEach(function (key) {
      q('.' + key).textContent = values[key];
    });

    // Credentials start masked.
    node.querySelectorAll('.secret').forEach(function (el) {
      el.classList.add('masked');
    });
    q('.reveal').addEventListener('click', function () {
      var masked = q('.stream-key').classList.contains('masked');
      node.querySelectorAll('.secret').forEach(function (el) {
        el.classList.toggle('masked', !masked);
      });
      q('.reveal').textContent = masked ? 'Hide' : 'Show';
    });

    node.querySelectorAll('.copy').forEach(function (button) {
      button.addEventListener('click', function () {
        copy(values[button.dataset.copy], button);
      });
    });

    function paintQr() {
      var qrUrl =
        '/api/streams/' +
        encodeURIComponent(stream.id) +
        '/qr.png?protocol=' +
        encodeURIComponent(q('.qr-protocol').value);
      if (token()) qrUrl += '&control_token=' + encodeURIComponent(token());
      q('.qr-img').src = qrUrl;
    }
    q('.qr-protocol').addEventListener('change', paintQr);
    paintQr();

    q('.check-status').addEventListener('click', async function () {
      var button = q('.check-status');
      button.disabled = true;
      try {
        var status = await api('/api/streams/' + encodeURIComponent(stream.id) + '/status');
        setLiveState(node, status.broadcasting, status.cached);
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        button.disabled = false;
      }
    });

    q('.delete').addEventListener('click', async function () {
      if (!window.confirm('Delete "' + stream.name + '"? Any encoder pointed at it will stop working.')) return;
      try {
        await api('/api/streams/' + encodeURIComponent(stream.id), { method: 'DELETE' });
        setStatus('Deleted ' + stream.name);
        load();
      } catch (error) {
        setStatus(error.message, true);
      }
    });

    return node;
  }

  function setLiveState(node, broadcasting, cached) {
    node.querySelector('.dot').classList.toggle('live', Boolean(broadcasting));
    node.querySelector('.state-label').textContent =
      (broadcasting ? 'receiving ingest' : 'offline') + (cached ? ' (cached)' : '');
  }

  async function load() {
    setStatus('loading…');
    try {
      var data = await api('/api/streams');
      els.streams.textContent = '';
      if (data.streams.length === 0) {
        var empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No live streams yet. Create one above.';
        els.streams.appendChild(empty);
      } else {
        data.streams.forEach(function (stream) {
          els.streams.appendChild(renderStream(stream));
        });
      }
      setStatus(data.streams.length + ' stream(s)');
    } catch (error) {
      els.streams.textContent = '';
      setStatus(error.message, true);
    }
  }

  els.form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var name = els.name.value.trim();
    if (!name) return;

    els.submit.disabled = true;
    setStatus('creating…');
    try {
      var stream = await api('/api/streams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name, public: els.isPublic.checked }),
      });
      els.name.value = '';
      setStatus('Created ' + stream.name);
      load();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      els.submit.disabled = false;
    }
  });

  els.refresh.addEventListener('click', load);

  /* ------------------------------------------------------------- pairing */

  var codeTimer = null;

  els.pairButton.addEventListener('click', async function () {
    els.pairButton.disabled = true;
    try {
      var pairing = await api('/api/pair', { method: 'POST' });
      els.pairCode.textContent = pairing.code;
      els.pairCode.hidden = false;
      countdown(new Date(pairing.expiresAt).getTime());
      loadDevices();
    } catch (error) {
      els.pairStatus.textContent = error.message;
      els.pairStatus.classList.add('error');
    } finally {
      els.pairButton.disabled = false;
    }
  });

  function countdown(expiresAt) {
    clearInterval(codeTimer);
    var tick = function () {
      var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      if (left === 0) {
        clearInterval(codeTimer);
        els.pairCode.hidden = true;
        els.pairStatus.textContent = 'Code expired. Press "Pair a device" for a new one.';
        return;
      }
      els.pairStatus.classList.remove('error');
      els.pairStatus.textContent = 'Type this code on the glasses — expires in ' + left + 's. Single use.';
    };
    tick();
    codeTimer = setInterval(tick, 1000);
  }

  async function loadDevices() {
    try {
      var data = await api('/api/devices');
      els.devices.textContent = '';

      if (data.devices.length === 0) {
        var empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No paired devices.';
        els.devices.appendChild(empty);
        return;
      }

      data.devices.forEach(function (device) {
        var row = document.createElement('div');
        row.className = 'device';

        var name = document.createElement('span');
        name.className = 'device-name';
        name.textContent = device.name;

        var meta = document.createElement('span');
        meta.className = 'device-meta';
        meta.textContent = 'paired ' + formatDate(device.pairedAt) + ' · last seen ' + formatDate(device.lastSeenAt);

        var revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'danger';
        revoke.textContent = 'Revoke';
        revoke.addEventListener('click', async function () {
          if (!window.confirm('Revoke "' + device.name + '"? It will need pairing again.')) return;
          try {
            await api('/api/devices/' + encodeURIComponent(device.id), { method: 'DELETE' });
            loadDevices();
          } catch (error) {
            els.pairStatus.textContent = error.message;
            els.pairStatus.classList.add('error');
          }
        });

        row.appendChild(name);
        row.appendChild(meta);
        row.appendChild(revoke);
        els.devices.appendChild(row);
      });
    } catch (error) {
      els.pairStatus.textContent = error.message;
      els.pairStatus.classList.add('error');
    }
  }

  fetch('/api/health')
    .then(function (response) {
      return response.json();
    })
    .then(function (health) {
      if (!health.pairing || !health.pairing.configured) {
        els.pairButton.disabled = true;
        els.pairStatus.textContent = 'Pairing is disabled — set JWT_SECRET in .env and restart.';
      } else {
        loadDevices();
      }

      if (!health.apiVideo || !health.apiVideo.configured) {
        els.envLine.textContent = 'api.video is not configured — set API_VIDEO_KEY in .env and restart.';
        els.submit.disabled = true;
        return;
      }
      els.envLine.textContent =
        'api.video environment: ' +
        health.apiVideo.environment +
        (health.controlTokenRequired ? ' · control token required' : ' · no control token set');
      load();
    })
    .catch(function (error) {
      els.envLine.textContent = 'Cannot reach the server: ' + error.message;
    });
})();
