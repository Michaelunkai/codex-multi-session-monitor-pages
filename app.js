'use strict';

(function () {
  var state = {
    token: '',
    endpoint: '',
    localAccess: false,
    localProbe: false,
    snapshot: null,
    search: '',
    eventSource: null,
    reconnectTimer: null,
    pollTimer: null,
    localRetryTimer: null,
    localProbePromise: null,
    lastLocalEndpoint: ''
  };

  function byId(id) { return document.getElementById(id); }
  function text(value, fallback) { return value === null || value === undefined || String(value) === '' ? (fallback || '') : String(value); }
  function browserUrl(value) {
    try { return new (window.URL || URL)(value, window.location.origin); } catch (error) { return null; }
  }

  function originOf(value) {
    if (!value || !String(value).trim()) return '';
    var parsed = browserUrl(value);
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return '';
    return parsed.origin;
  }

  function configuredEndpoint() {
    var meta = document.querySelector('meta[name="codex-monitor-endpoint"]');
    return window.CODEX_MONITOR_ENDPOINT || (meta && meta.getAttribute('content')) || '';
  }

  function configuredShareEndpoint() {
    var meta = document.querySelector('meta[name="codex-monitor-share-endpoint"]');
    return window.CODEX_MONITOR_SHARE_ENDPOINT || (meta && meta.getAttribute('content')) || '';
  }

  function configuredLocalEndpoint() {
    var meta = document.querySelector('meta[name="codex-monitor-local-endpoint"]');
    return window.CODEX_MONITOR_LOCAL_ENDPOINT || (meta && meta.getAttribute('content')) || '';
  }

  function defaultEndpoint() {
    return originOf(configuredEndpoint() || window.location.origin) || window.location.origin;
  }

  function deployedShellUrl() {
    var meta = document.querySelector('meta[name="codex-monitor-deploy-url"]');
    var configured = window.CODEX_MONITOR_DEPLOY_URL || (meta && meta.getAttribute('content')) || '';
    var parsed = browserUrl(configured);
    if (!parsed) return window.location.origin + window.location.pathname;
    return parsed.origin + (parsed.pathname || '/');
  }

  function tokenStorageKey(endpoint) {
    return 'codex-live-wall-token:' + String(endpoint || window.location.origin);
  }

  function readSavedToken(endpoint) {
    try {
      return window.localStorage ? (window.localStorage.getItem(tokenStorageKey(endpoint)) || '') : '';
    } catch (error) {
      return '';
    }
  }

  function saveToken(endpoint, token) {
    try {
      if (window.localStorage && token) window.localStorage.setItem(tokenStorageKey(endpoint), token);
    } catch (error) {}
  }

  function forgetToken(endpoint) {
    try {
      if (window.localStorage) window.localStorage.removeItem(tokenStorageKey(endpoint));
    } catch (error) {}
  }

  function parseAccessLink(value) {
    var parsed = browserUrl(value);
    if (!parsed) return null;
    var hashParams = new URLSearchParams((parsed.hash || '').replace(/^#/, ''));
    var token = hashParams.get('token') || parsed.searchParams.get('token') || '';
    var explicitEndpoint = hashParams.get('endpoint') || parsed.searchParams.get('endpoint') || '';
    var endpoint = originOf(explicitEndpoint);
    if (!endpoint && token && parsed.origin !== window.location.origin) endpoint = parsed.origin;
    if (!endpoint) endpoint = defaultEndpoint();
    return { endpoint: endpoint, token: token };
  }

  function apiUrl(pathname) {
    var parsed = browserUrl((state.endpoint || window.location.origin).replace(/\/+$/, '') + '/' + pathname.replace(/^\/+/, ''));
    if (!parsed) return pathname;
    if (state.token && !state.localAccess) parsed.searchParams.set('token', state.token);
    return parsed.toString();
  }

  function localEndpointCandidates() {
    var candidates = [];
    var configuredLocal = configuredLocalEndpoint();
    if (!configuredLocal) return candidates;
    function add(value) {
      var origin = originOf(value);
      if (origin && candidates.indexOf(origin) < 0) candidates.push(origin);
    }
    // Prefer the endpoint that was last proven healthy. START may choose a
    // different free port after a restart, so retain the full local range as
    // a deterministic failover rather than pinning the page to one port.
    add(state.lastLocalEndpoint);
    add(configuredLocal);
    for (var port = 8765; port <= 8800; port += 1) add('http://127.0.0.1:' + port);
    return candidates;
  }

  function scheduleLocalProbe(delay) {
    if (state.token || state.localRetryTimer) return;
    state.localRetryTimer = setTimeout(function () {
      state.localRetryTimer = null;
      probeLocalEndpoint().then(function (connected) {
        if (connected) connectEvents();
      });
    }, delay || 2500);
  }

  function probeLocalEndpoint() {
    if (state.localProbePromise) return state.localProbePromise;
    var candidates = localEndpointCandidates();
    var index = 0;
    function attempt() {
      if (index >= candidates.length) {
        state.localProbe = false;
        state.localAccess = false;
        state.endpoint = defaultEndpoint();
        setConnection('Looking for this PC', 'connection-reconnecting');
        setConnectPanel(true);
        setNotice('Waiting for the local monitor. This page will reconnect automatically when the PC monitor is ready; another machine can use its private access link.');
        scheduleLocalProbe(2500);
        return Promise.resolve(false);
      }
      state.endpoint = candidates[index++];
      state.localAccess = true;
      state.localProbe = true;
      var requestOptions = { cache: 'no-store', mode: 'cors', targetAddressSpace: 'loopback' };
      var abortTimer = null;
      if (window.AbortController) {
        var controller = new window.AbortController();
        requestOptions.signal = controller.signal;
        abortTimer = setTimeout(function () { controller.abort(); }, 1800);
      }
      return fetch(apiUrl('/api/snapshot'), requestOptions)
        .then(function (response) {
          if (abortTimer) clearTimeout(abortTimer);
          if (!response.ok) throw new Error('local probe HTTP ' + response.status);
          return response.json();
        })
        .then(function (snapshot) {
          state.localProbe = false;
          state.lastLocalEndpoint = state.endpoint;
          render(failClosedSnapshot(snapshot));
          setConnectPanel(false);
          setConnection('Live · this PC', 'connection-live');
          setNotice('');
          return true;
        })
        .catch(function () {
          if (abortTimer) clearTimeout(abortTimer);
          return attempt();
        });
    }
    state.localProbePromise = attempt().then(function (connected) {
      state.localProbePromise = null;
      return connected;
    }, function (error) {
      state.localProbePromise = null;
      throw error;
    });
    return state.localProbePromise;
  }

  function setConnection(label, className) {
    var badge = byId('connectionBadge');
    badge.textContent = label;
    badge.className = 'connection-badge ' + className;
  }

  function setNotice(message) {
    var notice = byId('notice');
    if (!message) {
      notice.textContent = '';
      notice.classList.add('hidden');
      return;
    }
    notice.textContent = message;
    notice.classList.remove('hidden');
  }

  function setConnectPanel(visible) {
    var panel = byId('connectPanel');
    if (panel) panel.classList.toggle('hidden', !visible);
  }

  function failClosedSnapshot(snapshot) {
    var sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
    if (!snapshot || snapshot.scope !== 'running-now' || snapshot.displayMode !== 'running-only') {
      throw new Error('server did not return the locked running-only view');
    }
    if (sessions.some(function (session) { return session.status !== 'RUNNING'; })) {
      throw new Error('server returned a non-running session; wall refused to render it');
    }
    return snapshot;
  }

  function formatAge(seconds) {
    if (seconds === null || seconds === undefined || !isFinite(seconds)) return 'unknown';
    var value = Number(seconds);
    if (value < 1) return 'just now';
    if (value < 60) return Math.max(1, Math.round(value)) + 's ago';
    if (value < 3600) return Math.round(value / 60) + 'm ago';
    return Math.round(value / 3600) + 'h ago';
  }

  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined || !isFinite(seconds)) return '—';
    var value = Math.max(0, Math.round(Number(seconds)));
    if (value < 60) return value + 's';
    var minutes = Math.floor(value / 60);
    if (minutes < 60) return minutes + 'm ' + (value % 60) + 's';
    return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
  }

  function formatDate(value) {
    if (!value) return 'unknown';
    var date = new Date(value);
    return isNaN(date.getTime()) ? 'unknown' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatEntryTime(value) {
    if (!value) return 'live';
    var date = new Date(value);
    return isNaN(date.getTime()) ? 'live' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function renderSummary(snapshot) {
    var summary = snapshot.summary || {};
    var sessions = snapshot.sessions || [];
    var outputCount = sessions.filter(function (session) { return Array.isArray(session.liveOutput) && session.liveOutput.length > 0; }).length;
    var running = Number(summary.runningCount);
    if (!isFinite(running)) running = sessions.length;
    byId('runningCount').textContent = String(running);
    byId('outputCount').textContent = String(outputCount);
    byId('hiddenCount').textContent = String(Number(summary.hiddenNonRunningCount) || 0);
    var freshness = Number(summary.freshnessSeconds);
    byId('freshnessValue').textContent = isFinite(freshness) ? (freshness < 1 ? '<1s' : Math.round(freshness) + 's') : '—';
    byId('footerVersion').textContent = 'Monitor ' + text(snapshot.serverVersion, '—');
    byId('sourceSummary').textContent = text(summary.outputTransport, 'Read-only rollout telemetry') + ' · automatic updates';
    byId('lastUpdate').textContent = 'Updated ' + formatDate(snapshot.generatedAt) + ' · running-only wall';
    if (summary.readErrors && summary.readErrors.length) {
      setNotice('Telemetry is degraded: ' + summary.readErrors.join(' | '));
    } else if (summary.telemetryErrorCount) {
      setNotice(String(summary.telemetryErrorCount) + ' session record(s) could not be read and were kept off the wall.');
    } else {
      setNotice('');
    }
  }

  function matchesSearch(session) {
    if (!state.search) return true;
    var haystack = [session.title, session.project, session.cwd, session.sourceLabel, session.model].join(' ').toLowerCase();
    return haystack.indexOf(state.search) >= 0;
  }

  function filteredSessions() {
    return ((state.snapshot && state.snapshot.sessions) || []).filter(function (session) {
      return session.status === 'RUNNING' && matchesSearch(session);
    });
  }

  function make(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function addDetail(list, label, value) {
    var row = make('div', 'detail-row');
    row.appendChild(make('span', 'detail-key', label));
    row.appendChild(make('span', 'detail-value', text(value, 'unknown')));
    list.appendChild(row);
  }

  function entryLabel(entry) {
    var type = text(entry && entry.type, 'output');
    var normalized = type.toLowerCase();
    if (normalized === 'assistant' || normalized === 'agentmessage') return 'Codex output · live';
    if (normalized === 'assistant-delta') return 'Codex output · streaming';
    if (normalized === 'commandexecution') return 'Command output';
    if (normalized === 'command-delta') return 'Command output · streaming';
    if (normalized === 'custom_tool_call_output') return 'Tool output';
    return type;
  }

  function renderActivity(session) {
    var activity = session.activity || {};
    var panel = make('div', 'live-activity');
    panel.setAttribute('aria-live', 'polite');
    var heading = make('div', 'live-activity-heading');
    heading.appendChild(make('span', 'live-activity-title', 'LIVE ACTIVITY'));
    var age = make('span', 'live-activity-age', formatAge(session.activityAgeSeconds !== undefined ? session.activityAgeSeconds : session.lastActivityAgeSeconds));
    if (activity.at) age.dataset.activityAt = activity.at;
    heading.appendChild(age);
    panel.appendChild(heading);
    var body = make('div', 'live-activity-body');
    body.appendChild(make('span', 'live-activity-pulse', '●'));
    body.appendChild(make('strong', 'live-activity-label', text(activity.label, 'Codex is working')));
    panel.appendChild(body);
    if (activity.detail) panel.appendChild(make('div', 'live-activity-detail', activity.detail));
    return panel;
  }

  function renderTranscript(session) {
    var panel = make('div', 'live-transcript');
    panel.setAttribute('aria-label', 'Live output for ' + text(session.title, 'Codex session'));
    var heading = make('div', 'transcript-heading');
    heading.appendChild(make('span', 'transcript-title', 'LIVE OUTPUT'));
    var direct = session.liveTransport === 'codex-ipc';
    heading.appendChild(make('span', 'transcript-state', direct ? 'DIRECT FROM DESKTOP · updating now' : 'read-only fallback · waiting for direct stream'));
    panel.appendChild(heading);
    var scroll = make('div', 'transcript-scroll');
    scroll.setAttribute('role', 'log');
    scroll.setAttribute('aria-live', 'off');
    var entries = Array.isArray(session.liveOutput) ? session.liveOutput : [];
    if (!entries.length) {
      scroll.appendChild(make('div', 'transcript-empty', 'Codex is running; no user-visible output has been committed yet.'));
    } else {
      entries.forEach(function (entry) {
        var block = make('section', 'transcript-entry');
        var meta = make('div', 'transcript-entry-meta');
        meta.appendChild(make('span', 'transcript-entry-kind', entryLabel(entry)));
        meta.appendChild(make('span', 'transcript-entry-time', formatEntryTime(entry.at)));
        block.appendChild(meta);
        block.appendChild(make('pre', 'transcript-text', text(entry.text, '')));
        if (entry.truncated) block.appendChild(make('div', 'transcript-warning', 'Output safety limit reached; older text is not shown.'));
        scroll.appendChild(block);
      });
    }
    panel.appendChild(scroll);
    return panel;
  }

  function renderCard(session, index, savedScroll) {
    var card = make('article', 'session-card status-running');
    card.dataset.sessionId = session.id;
    card.dataset.outputDigest = text(session.outputDigest, '');
    var top = make('div', 'card-top');
    top.appendChild(make('span', 'status-pill', 'RUNNING NOW'));
    top.appendChild(make('span', 'card-number', '#' + String(index + 1).padStart(2, '0')));
    card.appendChild(top);

    var titleRow = make('div', 'card-title-row');
    titleRow.appendChild(make('span', 'attention-mark live-mark', '●'));
    titleRow.appendChild(make('h2', 'card-title', text(session.title, 'Untitled Codex session')));
    card.appendChild(titleRow);

    var chips = make('div', 'chip-row');
    chips.appendChild(make('span', 'chip', text(session.sourceLabel, 'Codex local')));
    chips.appendChild(make('span', 'chip', text(session.project, 'Unknown project')));
    if (session.model && session.model !== 'unknown') chips.appendChild(make('span', 'chip', session.model));
    card.appendChild(chips);
    card.appendChild(renderActivity(session));
    card.appendChild(renderTranscript(session));

    var metrics = make('div', 'metric-row');
    var metricA = make('div', 'metric');
    metricA.appendChild(make('span', 'metric-label', 'Last event'));
    var activityValue = make('span', 'metric-value', formatAge(session.lastActivityAgeSeconds));
    if (session.lastActivityAt) activityValue.dataset.activityAt = session.lastActivityAt;
    metricA.appendChild(activityValue);
    metrics.appendChild(metricA);
    var metricB = make('div', 'metric');
    metricB.appendChild(make('span', 'metric-label', 'Elapsed'));
    var elapsedValue = make('span', 'metric-value', formatDuration(session.elapsedSeconds));
    if (session.latestTurnStartedAt) elapsedValue.dataset.startedAt = session.latestTurnStartedAt;
    metricB.appendChild(elapsedValue);
    metrics.appendChild(metricB);
    var metricC = make('div', 'metric');
    metricC.appendChild(make('span', 'metric-label', 'Output'));
    metricC.appendChild(make('span', 'metric-value', text(session.outputChars, '0') + ' chars'));
    metrics.appendChild(metricC);
    card.appendChild(metrics);

    if (session.progress && session.progress.total) {
      var progressText = 'Plan ' + text(session.progress.completed, '0') + '/' + text(session.progress.total, '0');
      if (session.progress.current) progressText += ' · ' + session.progress.current;
      card.appendChild(make('div', 'progress-line', progressText));
    }

    var details = document.createElement('details');
    details.appendChild(make('summary', '', 'Details'));
    var detailList = make('div', 'detail-list');
    addDetail(detailList, 'Working dir', session.cwd);
    addDetail(detailList, 'Turn id', session.latestTurnId);
    addDetail(detailList, 'Reliability', session.statusReliability);
    addDetail(detailList, 'Session id', session.id);
    details.appendChild(detailList);
    card.appendChild(details);
    if (savedScroll && savedScroll.open) details.open = true;
    return card;
  }

  function renderCards() {
    var container = byId('cards');
    var empty = byId('emptyState');
    var saved = {};
    Array.prototype.forEach.call(container.querySelectorAll('article'), function (card) {
      var scroll = card.querySelector('.transcript-scroll');
      var details = card.querySelector('details');
      saved[card.dataset.sessionId] = {
        top: scroll ? scroll.scrollTop : 0,
        open: details ? details.open : false,
        atBottom: scroll ? scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 24 : true
      };
    });
    container.textContent = '';
    var sessions = filteredSessions();
    sessions.forEach(function (session, index) {
      var card = renderCard(session, index, saved[session.id]);
      container.appendChild(card);
      var previous = saved[session.id];
      var scroll = card.querySelector('.transcript-scroll');
      if (previous && scroll) {
        scroll.scrollTop = previous.atBottom ? scroll.scrollHeight : previous.top;
      }
    });
    empty.classList.toggle('hidden', sessions.length !== 0);
  }

  function render(snapshot) {
    state.snapshot = snapshot;
    renderSummary(snapshot);
    renderCards();
  }

  function requestSnapshot() {
    if (!state.token && !state.localAccess) {
      setConnection('Token needed', 'connection-reconnecting');
      setConnectPanel(true);
      setNotice('Paste the complete private PC access URL below. It contains the bearer token in the URL fragment and is not sent to the hosting service.');
      return Promise.resolve();
    }
    var requestOptions = { cache: 'no-store' };
    if (state.token && !state.localAccess) requestOptions.headers = { Authorization: 'Bearer ' + state.token };
    if (state.localProbe && window.AbortController) {
      var controller = new window.AbortController();
      requestOptions.signal = controller.signal;
      setTimeout(function () { controller.abort(); }, 2500);
    }
    var probingLocal = state.localProbe;
    return fetch(apiUrl('/api/snapshot'), requestOptions)
      .then(function (response) {
        if (!response.ok) {
          if (response.status === 401) {
            forgetToken(state.endpoint);
            state.token = '';
            state.localAccess = false;
            state.localProbe = false;
            if (probingLocal) state.endpoint = defaultEndpoint();
            setConnection('Token needed', 'connection-reconnecting');
            setConnectPanel(true);
          }
          throw new Error('snapshot HTTP ' + response.status);
        }
        return response.json();
      })
      .then(function (snapshot) {
        state.localProbe = false;
        render(failClosedSnapshot(snapshot));
        setConnectPanel(false);
        setConnection(snapshot.source === 'synthetic-test' ? 'Test fixture' : (state.localAccess ? 'Live · this PC' : 'Live'), 'connection-live');
      })
      .catch(function (error) {
        if (probingLocal) {
          state.localProbe = false;
          state.localAccess = false;
          state.endpoint = defaultEndpoint();
          setConnection('Looking for this PC', 'connection-reconnecting');
          setConnectPanel(true);
          setNotice('Waiting for the local monitor. This page will reconnect automatically when it is ready.');
          scheduleLocalProbe(2500);
          return;
        }
        if (error && error.message === 'snapshot HTTP 401') {
          setConnection('Token needed', 'connection-reconnecting');
          setConnectPanel(true);
          setNotice('Paste the complete private PC access URL below. It contains the bearer token in the URL fragment and is not sent to the hosting service.');
          return;
        }
        setConnection('Reconnecting', 'connection-reconnecting');
        setNotice('Dashboard connection lost: ' + error.message);
        if (state.localAccess && !state.token) scheduleLocalProbe(500);
      });
  }

  function startPollingFallback() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(requestSnapshot, 2000);
  }

  function connectEvents() {
    if ((!state.token && !state.localAccess) || !window.EventSource) {
      startPollingFallback();
      return;
    }
    if (state.eventSource) state.eventSource.close();
    state.eventSource = new EventSource(apiUrl('/events'));
    state.eventSource.onopen = function () {
      if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    };
    state.eventSource.addEventListener('snapshot', function (event) {
      try {
        var snapshot = failClosedSnapshot(JSON.parse(event.data));
        render(snapshot);
        setConnection(snapshot.source === 'synthetic-test' ? 'Test fixture' : (state.localAccess ? 'Live · this PC' : 'Live'), 'connection-live');
      } catch (error) {
        setNotice('Invalid live snapshot: ' + error.message);
      }
    });
    state.eventSource.onerror = function () {
      setConnection('Reconnecting', 'connection-reconnecting');
      startPollingFallback();
      if (state.localAccess && !state.token) scheduleLocalProbe(500);
      if (state.reconnectTimer) return;
      state.reconnectTimer = setTimeout(function () {
        state.reconnectTimer = null;
        connectEvents();
      }, 3000);
    };
  }

  function updateUrlToken() {
    if (!state.token) return;
    saveToken(state.endpoint, state.token);
    var cleanUrl = window.location.origin + window.location.pathname;
    if (window.history && window.history.replaceState) window.history.replaceState({}, '', cleanUrl);
  }

  function buildAccessLink() {
    var fragment = 'token=' + encodeURIComponent(state.token);
    var shareEndpoint = originOf(configuredShareEndpoint()) || state.endpoint;
    if (shareEndpoint && shareEndpoint !== window.location.origin) fragment += '&endpoint=' + encodeURIComponent(shareEndpoint);
    return deployedShellUrl() + '#' + fragment;
  }

  function connectFromInput() {
    var input = byId('accessInput');
    var parsed = parseAccessLink(input && input.value);
    if (!parsed || !parsed.token) {
      setNotice('That is not a complete access URL. Paste the full URL printed by STATUS.cmd -ShowAccessUrl, including #token=...');
      return;
    }
    state.endpoint = parsed.endpoint;
    state.token = parsed.token;
    state.localAccess = originOf(state.endpoint) === window.location.origin;
    state.localProbe = false;
    updateUrlToken();
    if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    requestSnapshot().then(connectEvents);
  }

  function setup() {
    var initial = parseAccessLink(window.location.href) || { endpoint: defaultEndpoint(), token: '' };
    state.endpoint = initial.endpoint;
    state.token = initial.token || readSavedToken(state.endpoint);
    state.localAccess = originOf(state.endpoint) === window.location.origin;
    if (state.token && !state.localAccess) updateUrlToken();
    setInterval(function () {
      document.querySelectorAll('[data-activity-at]').forEach(function (node) { node.textContent = formatAge((Date.now() - Date.parse(node.dataset.activityAt)) / 1000); });
      document.querySelectorAll('[data-started-at]').forEach(function (node) { node.textContent = formatDuration((Date.now() - Date.parse(node.dataset.startedAt)) / 1000); });
    }, 1000);
    byId('searchInput').addEventListener('input', function (event) { state.search = event.target.value.toLowerCase().trim(); renderCards(); });
    byId('refreshButton').addEventListener('click', requestSnapshot);
    if (byId('connectButton')) byId('connectButton').addEventListener('click', connectFromInput);
    byId('copyButton').addEventListener('click', function () {
      if (!state.token) return;
      var link = buildAccessLink();
      navigator.clipboard.writeText(link).then(function () {
        byId('copyButton').textContent = 'Copied';
        setTimeout(function () { byId('copyButton').textContent = 'Copy access link'; }, 1600);
      }).catch(function () { setNotice('Copy was blocked; use the URL in the browser address bar.'); });
    });
    setConnectPanel(!state.token && !state.localAccess);
    if (!state.token && !state.localAccess) {
      probeLocalEndpoint().then(function (connected) { if (connected) connectEvents(); });
    } else {
      requestSnapshot().then(connectEvents);
    }
  }

  document.addEventListener('DOMContentLoaded', setup);
}());
