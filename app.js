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
    localFirst: false,
    lastLocalEndpoint: '',
    copyTokenPromise: null,
    copyReady: false,
    snapshotRequestPromise: null,
    snapshotRefreshQueued: false,
    scriptFallback: false,
    scriptPollTimer: null,
    scriptRequestPromise: null,
    scriptRefreshQueued: false
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

  function isLoopbackOrigin(value) {
    var parsed = browserUrl(value);
    if (!parsed) return false;
    if (parsed.protocol !== 'http:') return false;
    var host = String(parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  }

  function isLocalWallPage() {
    return isLoopbackOrigin(window.location.origin);
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
    if (isLocalWallPage()) return window.location.origin;
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
    if (!configuredLocal && !isLocalWallPage()) return candidates;
    function add(value) {
      var origin = originOf(value);
      if (origin && candidates.indexOf(origin) < 0) candidates.push(origin);
    }
    // Prefer the endpoint that was last proven healthy. START may choose a
    // different free port after a restart, so retain the full local range as
    // a deterministic failover rather than pinning the page to one port.
    if (isLocalWallPage()) add(window.location.origin);
    add(state.lastLocalEndpoint);
    add(configuredLocal);
    for (var port = 8765; port <= 8800; port += 1) add('http://127.0.0.1:' + port);
    return candidates;
  }

  function scheduleLocalProbe(delay) {
    if ((!state.localFirst && !(state.localAccess && !state.token)) || state.localRetryTimer) return;
    state.localFirst = true;
    state.localRetryTimer = setTimeout(function () {
      state.localRetryTimer = null;
      probeLocalEndpoint().then(function (connected) {
        if (connected) connectEvents();
      });
    }, delay || 2500);
  }

  function cancelLocalProbeRetry() {
    if (!state.localRetryTimer) return;
    clearTimeout(state.localRetryTimer);
    state.localRetryTimer = null;
  }

  function probeLocalEndpoint(quickOnly) {
    if (state.localProbePromise) return state.localProbePromise;
    var candidates = localEndpointCandidates();
    if (quickOnly) candidates = candidates.slice(0, 1);
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
        // A live wall carries complete per-session transcripts. A healthy
        // local snapshot can therefore be several megabytes and may need a
        // few seconds to transfer and parse before the PC is considered found.
        abortTimer = setTimeout(function () { controller.abort(); }, 10000);
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
          state.localFirst = false;
          render(failClosedSnapshot(snapshot));
          setConnectPanel(false);
          setConnection('Live · this PC', 'connection-live');
          setNotice('');
          accessTokenForCopy().catch(function () {});
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

  function setCopyStatus(message, tone) {
    var status = byId('copyStatus');
    if (!status) return;
    status.textContent = message || '';
    status.className = 'copy-status' + (tone ? ' copy-status-' + tone : '');
  }

  function markCopyReady() {
    state.copyReady = true;
    setCopyStatus('Ready for Android · one tap copies the private link', 'ready');
  }

  function markCopyWaiting(message) {
    state.copyReady = false;
    setCopyStatus(message || 'Preparing private Android link…', 'waiting');
  }

  function markCopyUnavailable(message) {
    state.copyReady = false;
    setCopyStatus(message || 'Private link unavailable', 'error');
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
    var summary = snapshot.summary || {};
    if (!Number.isInteger(Number(summary.runningCount)) || Number(summary.runningCount) < 0 || Number(summary.runningCount) !== sessions.length) {
      throw new Error('server running count did not match the live session list');
    }
    var ids = new Set();
    for (var sessionIndex = 0; sessionIndex < sessions.length; sessionIndex += 1) {
      var sessionId = text(sessions[sessionIndex] && sessions[sessionIndex].id, '');
      if (!sessionId || ids.has(sessionId)) throw new Error('server returned duplicate or missing live session ids');
      ids.add(sessionId);
    }
    if (sessions.some(function (session) { return session.status !== 'RUNNING'; })) {
      throw new Error('server returned a non-running session; wall refused to render it');
    }
    return snapshot;
  }

  function outputEntryKey(entry, index) {
    var id = text(entry && entry.id, '');
    return id ? 'id:' + id : 'ordinal:' + text(entry && entry.ordinal, '0') + ':' + String(index);
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function applyOutputDelta(entries, output) {
    var current = Array.isArray(entries) ? entries.map(function (entry) { return { ...entry }; }) : [];
    if (!output) return current;
    if (output.mode === 'replace') {
      if (!Array.isArray(output.entries)) return null;
      return output.entries.map(function (entry) { return { ...entry }; });
    }
    if (output.mode !== 'patch' || !Array.isArray(output.upserts) || !Array.isArray(output.removedIds)) return null;
    var removed = new Set(output.removedIds);
    current = current.filter(function (entry, index) { return !removed.has(outputEntryKey(entry, index)); });
    var byKey = new Map();
    current.forEach(function (entry, index) { byKey.set(outputEntryKey(entry, index), index); });
    for (var index = 0; index < output.upserts.length; index += 1) {
      var patch = output.upserts[index];
      var key = outputEntryKey(patch, index);
      var existingIndex = byKey.get(key);
      if (hasOwn(patch, 'appendText')) {
        if (existingIndex === undefined) return null;
        var appended = { ...current[existingIndex], ...patch, text: text(current[existingIndex].text) + text(patch.appendText) };
        delete appended.appendText;
        current[existingIndex] = appended;
      } else if (patch.keepText) {
        if (existingIndex === undefined) return null;
        var metadata = { ...current[existingIndex], ...patch };
        delete metadata.keepText;
        current[existingIndex] = metadata;
      } else if (existingIndex === undefined) {
        current.push({ ...patch });
        byKey.set(key, current.length - 1);
      } else {
        current[existingIndex] = { ...current[existingIndex], ...patch };
      }
    }
    return current.sort(function (left, right) {
      return (Number(left.ordinal) - Number(right.ordinal)) || (Number(left.timestampMs) - Number(right.timestampMs));
    });
  }

  function applyDelta(delta) {
    if (!state.snapshot || !delta || delta.type !== 'delta') return null;
    if (delta.scope !== 'running-now' || delta.displayMode !== 'running-only') throw new Error('server did not return the locked running-only delta');
    if (!Number.isInteger(delta.baseRevision) || !Number.isInteger(delta.revision) || delta.revision !== delta.baseRevision + 1) return null;
    if (Number(state.snapshot.revision) !== delta.baseRevision) return null;
    if (!Array.isArray(delta.added) || !Array.isArray(delta.updated) || !Array.isArray(delta.removedIds)) throw new Error('invalid live delta shape');
    var removed = new Set(delta.removedIds.map(String));
    var sessions = (state.snapshot.sessions || []).filter(function (session) { return !removed.has(String(session.id)); }).map(function (session) {
      return { ...session, liveOutput: Array.isArray(session.liveOutput) ? session.liveOutput.map(function (entry) { return { ...entry }; }) : [] };
    });
    var byId = new Map(sessions.map(function (session, index) { return [String(session.id), index]; }));
    for (var addIndex = 0; addIndex < delta.added.length; addIndex += 1) {
      var added = delta.added[addIndex];
      if (!added || added.status !== 'RUNNING' || byId.has(String(added.id))) throw new Error('invalid added live session');
      sessions.push({ ...added, liveOutput: Array.isArray(added.liveOutput) ? added.liveOutput.map(function (entry) { return { ...entry }; }) : [] });
      byId.set(String(added.id), sessions.length - 1);
    }
    for (var updateIndex = 0; updateIndex < delta.updated.length; updateIndex += 1) {
      var update = delta.updated[updateIndex];
      var sessionIndex = byId.get(String(update && update.id));
      if (sessionIndex === undefined || !update || !update.session) return null;
      var prior = sessions[sessionIndex];
      var liveOutput = applyOutputDelta(prior.liveOutput, update.output);
      if (!liveOutput || update.session.status !== 'RUNNING') return null;
      sessions[sessionIndex] = { ...prior, ...update.session, liveOutput: liveOutput };
    }
    sessions.sort(function (left, right) { return String(right.lastActivityAt || '').localeCompare(String(left.lastActivityAt || '')); });
    var next = failClosedSnapshot({
      ...state.snapshot,
      schemaVersion: delta.schemaVersion || state.snapshot.schemaVersion,
      revision: delta.revision,
      generatedAt: delta.generatedAt,
      source: delta.source,
      scope: delta.scope,
      displayMode: delta.displayMode,
      summary: delta.summary,
      sessions: sessions
    });
    return { snapshot: next, updated: delta.updated, added: delta.added, removedIds: delta.removedIds };
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
    // failClosedSnapshot proves this is the authoritative exact count. Never
    // display a separate, potentially stale count from a filtered DOM view.
    var running = sessions.length;
    byId('runningCount').textContent = String(running);
    byId('outputCount').textContent = outputCount + ' / ' + running;
    var statusRunningCount = byId('statusRunningCount');
    if (statusRunningCount) statusRunningCount.textContent = String(running);
    var statusOutputCoverage = byId('statusOutputCoverage');
    if (statusOutputCoverage) statusOutputCoverage.textContent = outputCount + '/' + running + ' with exact output';
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
    renderSessionIndex();
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

  function previewText(value, limit) {
    var result = text(value, '').replace(/\s+/g, ' ').trim();
    if (!result) return 'No user-visible output committed yet.';
    var max = limit || 220;
    return result.length > max ? result.slice(0, max - 1) + '…' : result;
  }

  function latestOutputPreview(session) {
    var entries = Array.isArray(session && session.liveOutput) ? session.liveOutput : [];
    for (var index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index] && text(entries[index].text, '').trim()) return previewText(entries[index].text, 240);
    }
    var latest = session && session.latestItem;
    return previewText(latest && (latest.text || latest.preview), 240);
  }

  function renderSessionIndex() {
    var container = byId('sessionIndex');
    if (!container) return;
    var sessions = filteredSessions();
    container.textContent = '';
    sessions.forEach(function (session, index) {
      var row = make('article', 'session-index-row');
      row.dataset.indexSessionId = session.id;
      row.setAttribute('role', 'listitem');

      row.appendChild(make('span', 'session-index-number', '#' + String(index + 1).padStart(2, '0')));

      var identity = make('div', 'session-index-identity');
      var titleLine = make('div', 'session-index-title-line');
      titleLine.appendChild(make('span', 'session-index-status-dot', '●'));
      titleLine.appendChild(make('strong', 'session-index-title', text(session.title, 'Untitled Codex session')));
      identity.appendChild(titleLine);
      identity.appendChild(make('div', 'session-index-subtitle', text(session.project, 'Unknown project') + ' · ' + text(session.model, 'model unknown')));
      row.appendChild(identity);

      var activity = session.activity || {};
      var activityCell = make('div', 'session-index-activity');
      activityCell.appendChild(make('span', 'session-index-label', 'NOW'));
      activityCell.appendChild(make('strong', '', text(activity.label, 'Codex is working')));
      activityCell.appendChild(make('span', 'session-index-age', formatAge(session.activityAgeSeconds !== undefined ? session.activityAgeSeconds : session.lastActivityAgeSeconds)));
      row.appendChild(activityCell);

      var preview = make('div', 'session-index-preview');
      preview.appendChild(make('span', 'session-index-label', 'LATEST OUTPUT'));
      preview.appendChild(make('span', '', latestOutputPreview(session)));
      row.appendChild(preview);
      container.appendChild(row);
    });
    var meta = byId('sessionIndexMeta');
    var totalSessions = state.snapshot && Array.isArray(state.snapshot.sessions) ? state.snapshot.sessions.length : sessions.length;
    if (meta) meta.textContent = state.search
      ? sessions.length + ' of ' + totalSessions + ' live · filtered'
      : totalSessions + ' live · every session shown';
    var feedCount = byId('feedCount');
    if (feedCount) feedCount.textContent = state.search
      ? sessions.length + ' of ' + totalSessions + ' transcript' + (totalSessions === 1 ? '' : 's')
      : sessions.length + ' live transcript' + (sessions.length === 1 ? '' : 's');
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

  function transcriptStateText(session) {
    return session.liveTransport === 'codex-ipc' ? 'LIVE DESKTOP IPC · updating now' : 'LIVE CODEX ROLLOUT · updating now';
  }

  function transcriptCountText(session) {
    var entries = Array.isArray(session && session.liveOutput) ? session.liveOutput : [];
    var chars = Number(session && session.outputChars);
    if (!isFinite(chars)) chars = entries.reduce(function (total, entry) { return total + text(entry && entry.text, '').length; }, 0);
    return entries.length + ' event' + (entries.length === 1 ? '' : 's') + ' · ' + chars + ' chars';
  }

  function visibleTranscriptEntries(entries) {
    var source = Array.isArray(entries) ? entries : [];
    var maxEntries = 24;
    var maxChars = 120000;
    var selected = [];
    var chars = 0;
    var omitted = false;
    for (var index = source.length - 1; index >= 0; index -= 1) {
      if (selected.length >= maxEntries || chars >= maxChars) {
        omitted = true;
        break;
      }
      var entry = source[index] || {};
      var entryText = text(entry.text, '');
      var remaining = maxChars - chars;
      if (entryText.length > remaining) {
        selected.push({
          ...entry,
          text: entryText.slice(-remaining),
          presentationTruncated: true
        });
        chars += remaining;
        omitted = true;
        break;
      }
      selected.push(entry);
      chars += entryText.length;
    }
    selected.reverse();
    if ((omitted || selected.length < source.length) && selected.length) {
      selected[0] = { ...selected[0], presentationTruncated: true };
    }
    return selected;
  }

  function renderTranscriptEntry(entry, index) {
    var block = make('section', 'transcript-entry');
    block.dataset.entryKey = outputEntryKey(entry, index);
    var meta = make('div', 'transcript-entry-meta');
    meta.appendChild(make('span', 'transcript-entry-kind', entryLabel(entry)));
    meta.appendChild(make('span', 'transcript-entry-time', formatEntryTime(entry.at)));
    block.appendChild(meta);
    block.appendChild(make('pre', 'transcript-text', text(entry.text, '')));
    if (entry.truncated || entry.presentationTruncated) {
      block.appendChild(make('div', 'transcript-warning', 'Showing the newest live output; older transcript text is kept out of the page for instant, readable updates.'));
    }
    return block;
  }

  function renderTranscriptContents(scroll, entries) {
    scroll.textContent = '';
    var visibleEntries = visibleTranscriptEntries(entries);
    if (!visibleEntries.length) {
      scroll.appendChild(make('div', 'transcript-empty', 'Codex is running; no user-visible output has been committed yet.'));
      return;
    }
    visibleEntries.forEach(function (entry, index) { scroll.appendChild(renderTranscriptEntry(entry, index)); });
  }

  function renderTranscript(session) {
    var panel = make('div', 'live-transcript');
    panel.setAttribute('aria-label', 'Live output for ' + text(session.title, 'Codex session'));
    var heading = make('div', 'transcript-heading');
    heading.appendChild(make('span', 'transcript-title', 'LIVE OUTPUT'));
    heading.appendChild(make('span', 'transcript-state', transcriptStateText(session)));
    heading.appendChild(make('span', 'transcript-count', transcriptCountText(session)));
    panel.appendChild(heading);
    var scroll = make('div', 'transcript-scroll');
    scroll.setAttribute('role', 'log');
    scroll.setAttribute('aria-live', 'off');
    var entries = Array.isArray(session.liveOutput) ? session.liveOutput : [];
    renderTranscriptContents(scroll, entries);
    panel.appendChild(scroll);
    return panel;
  }

  function renderChipRow(session) {
    var chips = make('div', 'chip-row');
    chips.appendChild(make('span', 'chip', text(session.sourceLabel, 'Codex local')));
    chips.appendChild(make('span', 'chip', text(session.project, 'Unknown project')));
    if (session.model && session.model !== 'unknown') chips.appendChild(make('span', 'chip', session.model));
    return chips;
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

    card.appendChild(renderChipRow(session));
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

  function cardForSession(id) {
    var cards = byId('cards').querySelectorAll('article');
    for (var index = 0; index < cards.length; index += 1) {
      if (String(cards[index].dataset.sessionId) === String(id)) return cards[index];
    }
    return null;
  }

  function transcriptEntryFor(scroll, key) {
    var entries = scroll.querySelectorAll('.transcript-entry');
    for (var index = 0; index < entries.length; index += 1) {
      if (entries[index].dataset.entryKey === key) return entries[index];
    }
    return null;
  }

  function updateTranscriptEntry(block, entry, index) {
    block.dataset.entryKey = outputEntryKey(entry, index);
    block.querySelector('.transcript-entry-kind').textContent = entryLabel(entry);
    block.querySelector('.transcript-entry-time').textContent = formatEntryTime(entry.at);
    block.querySelector('.transcript-text').textContent = text(entry.text, '');
    var warning = block.querySelector('.transcript-warning');
    var showWarning = entry.truncated || entry.presentationTruncated;
    if (showWarning && !warning) block.appendChild(make('div', 'transcript-warning', 'Showing the newest live output; older transcript text is kept out of the page for instant, readable updates.'));
    if (!showWarning && warning) warning.remove();
  }

  function syncTranscript(card, session, output) {
    var transcript = card.querySelector('.live-transcript');
    var scroll = card.querySelector('.transcript-scroll');
    if (!transcript || !scroll) return;
    transcript.querySelector('.transcript-state').textContent = transcriptStateText(session);
    var count = transcript.querySelector('.transcript-count');
    if (count) count.textContent = transcriptCountText(session);
    if (!output) return;
    var entries = Array.isArray(session.liveOutput) ? session.liveOutput : [];
    var wasAtBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 24;
    if (output.mode !== 'patch') {
      renderTranscriptContents(scroll, entries);
    } else {
      output.removedIds.forEach(function (key) {
        var removed = transcriptEntryFor(scroll, key);
        if (removed) removed.remove();
      });
      output.upserts.forEach(function (patch, patchIndex) {
        var key = outputEntryKey(patch, patchIndex);
        var entryIndex = entries.findIndex(function (entry, index) { return outputEntryKey(entry, index) === key; });
        if (entryIndex < 0) return;
        var entry = entries[entryIndex];
        var block = transcriptEntryFor(scroll, key);
        if (block) updateTranscriptEntry(block, entry, entryIndex);
        else {
          var empty = scroll.querySelector('.transcript-empty');
          if (empty) empty.remove();
          scroll.appendChild(renderTranscriptEntry(entry, entryIndex));
        }
      });
      var blocks = scroll.querySelectorAll('.transcript-entry');
      var ordered = blocks.length === entries.length;
      for (var index = 0; ordered && index < entries.length; index += 1) {
        ordered = blocks[index].dataset.entryKey === outputEntryKey(entries[index], index);
      }
      if (!ordered) renderTranscriptContents(scroll, entries);
    }
    if (wasAtBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  function updateCard(session, output) {
    var card = cardForSession(session.id);
    if (!card) return false;
    card.dataset.outputDigest = text(session.outputDigest, '');
    card.querySelector('.card-title').textContent = text(session.title, 'Untitled Codex session');
    var oldChips = card.querySelector('.chip-row');
    if (oldChips) oldChips.parentNode.replaceChild(renderChipRow(session), oldChips);
    var oldActivity = card.querySelector('.live-activity');
    if (oldActivity) oldActivity.parentNode.replaceChild(renderActivity(session), oldActivity);
    syncTranscript(card, session, output);
    var metrics = card.querySelectorAll('.metric-value');
    if (metrics.length >= 3) {
      if (session.lastActivityAt) {
        metrics[0].dataset.activityAt = session.lastActivityAt;
        metrics[0].textContent = formatAge((Date.now() - Date.parse(session.lastActivityAt)) / 1000);
      } else {
        metrics[0].removeAttribute('data-activity-at');
        metrics[0].textContent = formatAge(session.lastActivityAgeSeconds);
      }
      if (session.latestTurnStartedAt) {
        metrics[1].dataset.startedAt = session.latestTurnStartedAt;
        metrics[1].textContent = formatDuration((Date.now() - Date.parse(session.latestTurnStartedAt)) / 1000);
      } else {
        metrics[1].removeAttribute('data-started-at');
        metrics[1].textContent = formatDuration(session.elapsedSeconds);
      }
      metrics[2].textContent = text(session.outputChars, '0') + ' chars';
    }
    var detailValues = card.querySelectorAll('.detail-value');
    if (detailValues.length >= 4) {
      detailValues[0].textContent = text(session.cwd, 'unknown');
      detailValues[1].textContent = text(session.latestTurnId, 'unknown');
      detailValues[2].textContent = text(session.statusReliability, 'unknown');
      detailValues[3].textContent = text(session.id, 'unknown');
    }
    return true;
  }

  function revealLatestTranscript(card) {
    var scroll = card && card.querySelector('.transcript-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  function syncCardOrder() {
    var container = byId('cards');
    var sessions = filteredSessions();
    var visibleIds = new Set(sessions.map(function (session) { return String(session.id); }));
    sessions.forEach(function (session, index) {
      var card = cardForSession(session.id);
      var created = false;
      if (!card) {
        card = renderCard(session, index, null);
        created = true;
      }
      var number = card.querySelector('.card-number');
      if (number) number.textContent = '#' + String(index + 1).padStart(2, '0');
      container.appendChild(card);
      if (created) revealLatestTranscript(card);
    });
    Array.prototype.forEach.call(container.querySelectorAll('article'), function (card) {
      if (!visibleIds.has(String(card.dataset.sessionId))) card.remove();
    });
    byId('emptyState').classList.toggle('hidden', sessions.length !== 0);
  }

  function renderDelta(result) {
    state.snapshot = result.snapshot;
    renderSummary(result.snapshot);
    var sessions = new Map((result.snapshot.sessions || []).map(function (session) { return [String(session.id), session]; }));
    result.updated.forEach(function (update) {
      var session = sessions.get(String(update.id));
      if (session) updateCard(session, update.output);
    });
    syncCardOrder();
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
      } else {
        revealLatestTranscript(card);
      }
    });
    empty.classList.toggle('hidden', sessions.length !== 0);
    renderSessionIndex();
  }

  function render(snapshot) {
    state.snapshot = snapshot;
    renderSummary(snapshot);
    renderCards();
  }

  function localScriptTransportAvailable() {
    return state.localAccess && !state.token && originOf(state.endpoint) === originOf(window.location.origin);
  }

  function useBootstrapSnapshot() {
    var snapshot = window.__CODEX_MONITOR_BOOTSTRAP__;
    try {
      if (!snapshot) {
        var bootstrapNode = byId('codexMonitorBootstrap');
        if (!bootstrapNode) return false;
        snapshot = JSON.parse(bootstrapNode.textContent || '');
      }
      render(failClosedSnapshot(snapshot));
      setConnectPanel(false);
      setConnection('Live · this PC', 'connection-live');
      setNotice('');
      return true;
    } catch (error) {
      return false;
    }
  }

  function scriptSnapshotUrl() {
    var parsed = browserUrl((state.endpoint || window.location.origin).replace(/\/+$/, '') + '/wall.js');
    if (!parsed) return '/wall.js';
    parsed.searchParams.set('_', String(Date.now()));
    return parsed.toString();
  }

  function stopScriptPolling() {
    if (!state.scriptPollTimer) return;
    clearInterval(state.scriptPollTimer);
    state.scriptPollTimer = null;
  }

  function startScriptPolling() {
    if (!localScriptTransportAvailable() || state.scriptPollTimer) return;
    state.scriptPollTimer = setInterval(function () { requestScriptSnapshot(); }, 500);
  }

  function requestScriptSnapshot() {
    if (!localScriptTransportAvailable()) return Promise.reject(new Error('local script transport is unavailable'));
    if (state.scriptRequestPromise) {
      state.scriptRefreshQueued = true;
      return state.scriptRequestPromise;
    }
    var request = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var timeout = setTimeout(function () {
        cleanup();
        reject(new Error('local script snapshot timed out'));
      }, 12000);
      function cleanup() {
        clearTimeout(timeout);
        script.onload = null;
        script.onerror = null;
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      script.async = true;
      script.src = scriptSnapshotUrl();
      script.onload = function () {
        var snapshot = window.__CODEX_MONITOR_SCRIPT_SNAPSHOT__;
        cleanup();
        if (!snapshot) {
          reject(new Error('local script snapshot was empty'));
          return;
        }
        try {
          render(failClosedSnapshot(snapshot));
          state.localProbe = false;
          state.scriptFallback = true;
          setConnectPanel(false);
          setConnection('Live · this PC', 'connection-live');
          setNotice('');
          resolve(snapshot);
        } catch (error) {
          reject(error);
        }
      };
      script.onerror = function () {
        cleanup();
        reject(new Error('local script snapshot failed to load'));
      };
      document.head.appendChild(script);
    });
    state.scriptRequestPromise = request;
    request.finally(function () {
      if (state.scriptRequestPromise !== request) return;
      state.scriptRequestPromise = null;
      if (!state.scriptRefreshQueued) return;
      state.scriptRefreshQueued = false;
      requestScriptSnapshot();
    });
    return request;
  }

  function recoverWithLocalScriptTransport() {
    if (!localScriptTransportAvailable()) return Promise.reject(new Error('local script transport is unavailable'));
    state.scriptFallback = true;
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    startScriptPolling();
    return requestScriptSnapshot();
  }

  function requestSnapshot(compactFirst) {
    if (state.scriptFallback && localScriptTransportAvailable()) return requestScriptSnapshot();
    if (!state.token && !state.localAccess) {
      setConnection('Token needed', 'connection-reconnecting');
      setConnectPanel(true);
      setNotice('Paste the complete private PC access URL below. It contains the bearer token in the URL fragment and is not sent to the hosting service.');
      return Promise.resolve();
    }
    if (state.snapshotRequestPromise) {
      state.snapshotRefreshQueued = true;
      return state.snapshotRequestPromise;
    }
    var requestOptions = { cache: 'no-store' };
    if (state.token && !state.localAccess) requestOptions.headers = { Authorization: 'Bearer ' + state.token };
    if (state.localProbe && window.AbortController) {
      var controller = new window.AbortController();
      requestOptions.signal = controller.signal;
      setTimeout(function () { controller.abort(); }, 2500);
    }
    var probingLocal = state.localProbe;
    var snapshotPath = compactFirst ? '/api/snapshot?compact=1' : '/api/snapshot';
    var request = fetch(apiUrl(snapshotPath), requestOptions)
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
        if (state.localAccess || state.token) accessTokenForCopy().catch(function () {});
        // A remote wall first paints the exact running set and activity from a
        // small compact snapshot. Immediately hydrate the complete verbatim
        // transcripts in the background; subsequent SSE deltas stay compact.
        if (compactFirst && snapshot.compact) state.snapshotRefreshQueued = true;
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
        if (localScriptTransportAvailable()) {
          return recoverWithLocalScriptTransport().catch(function (scriptError) {
            setConnection('Reconnecting', 'connection-reconnecting');
            setNotice('Dashboard connection lost: ' + error.message + ' · local fallback: ' + scriptError.message);
          });
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
    state.snapshotRequestPromise = request;
    request.finally(function () {
      if (state.snapshotRequestPromise !== request) return;
      state.snapshotRequestPromise = null;
      if (!state.snapshotRefreshQueued) return;
      state.snapshotRefreshQueued = false;
      requestSnapshot();
    });
    return request;
  }

  function startPollingFallback() {
    if (state.scriptFallback && localScriptTransportAvailable()) {
      startScriptPolling();
      return;
    }
    if (state.pollTimer) return;
    state.pollTimer = setInterval(requestSnapshot, 2000);
  }

  function connectEvents() {
    if (state.scriptFallback && localScriptTransportAvailable()) {
      startScriptPolling();
      return;
    }
    if ((!state.token && !state.localAccess) || !window.EventSource) {
      if (localScriptTransportAvailable()) {
        recoverWithLocalScriptTransport().catch(function (error) {
          setConnection('Reconnecting', 'connection-reconnecting');
          setNotice('Dashboard connection lost: ' + error.message);
        });
        return;
      }
      startPollingFallback();
      return;
    }
    if (state.eventSource) state.eventSource.close();
    state.eventSource = new EventSource(apiUrl('/events?mode=delta'));
    state.eventSource.onopen = function () {
      if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
      requestSnapshot();
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
    state.eventSource.addEventListener('changed', function (event) {
      try {
        var change = JSON.parse(event.data);
        if (!Number.isInteger(change.revision) || change.revision < 1) throw new Error('invalid revision notification');
        var currentRevision = Number(state.snapshot && state.snapshot.revision) || 0;
        if (!state.snapshot || change.revision > currentRevision) requestSnapshot();
      } catch (error) {
        setNotice('Invalid live revision: ' + error.message);
      }
    });
    state.eventSource.addEventListener('delta', function (event) {
      try {
        var delta = JSON.parse(event.data);
        if (state.snapshotRequestPromise) {
          state.snapshotRefreshQueued = true;
          return;
        }
        var result = applyDelta(delta);
        if (!result) {
          requestSnapshot();
          return;
        }
        renderDelta(result);
        setConnectPanel(false);
        setConnection(result.snapshot.source === 'synthetic-test' ? 'Test fixture' : (state.localAccess ? 'Live · this PC' : 'Live'), 'connection-live');
      } catch (error) {
        setNotice('Invalid live delta: ' + error.message);
        requestSnapshot();
      }
    });
    state.eventSource.onerror = function () {
      setConnection('Reconnecting', 'connection-reconnecting');
      if (localScriptTransportAvailable()) {
        recoverWithLocalScriptTransport().catch(function (error) {
          setNotice('Dashboard connection lost: ' + error.message);
        });
        return;
      }
      startPollingFallback();
      if (state.localAccess && !state.token) scheduleLocalProbe(500);
      if (state.reconnectTimer) return;
      state.reconnectTimer = setTimeout(function () {
        state.reconnectTimer = null;
        connectEvents();
      }, 1000);
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

  function accessTokenForCopy() {
    if (state.token) {
      markCopyReady();
      return Promise.resolve(state.token);
    }
    if (!state.localAccess) {
      markCopyUnavailable('Connect this wall to the PC before copying');
      return Promise.reject(new Error('No private access token is available on this connection.'));
    }
    if (state.copyTokenPromise) return state.copyTokenPromise;
    markCopyWaiting('Preparing private Android link…');
    state.copyTokenPromise = fetch(apiUrl('/api/access-link'), { cache: 'no-store', mode: 'cors', targetAddressSpace: 'loopback' })
      .then(function (response) {
        if (!response.ok) throw new Error('local access-link HTTP ' + response.status);
        return response.json();
      })
      .then(function (payload) {
        if (!payload || typeof payload.token !== 'string' || payload.token.length < 32) throw new Error('local access-link response was invalid');
        state.token = payload.token;
        saveToken(originOf(configuredShareEndpoint()) || state.endpoint, state.token);
        markCopyReady();
        return state.token;
      })
      .catch(function (error) {
        markCopyUnavailable('Private link is not ready yet');
        throw error;
      })
      .finally(function () { state.copyTokenPromise = null; });
    return state.copyTokenPromise;
  }

  function fallbackCopyText(value) {
    var area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var copied = false;
    try { copied = document.execCommand('copy'); } catch (error) { copied = false; }
    area.remove();
    return copied ? Promise.resolve() : Promise.reject(new Error('clipboard access was blocked'));
  }

  function copyText(value) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(value).catch(function () { return fallbackCopyText(value); });
    }
    return fallbackCopyText(value);
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
    markCopyReady();
    state.localAccess = originOf(state.endpoint) === window.location.origin;
    state.localProbe = false;
    updateUrlToken();
    if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    requestSnapshot(true).then(connectEvents);
  }

  function setup() {
    var initial = parseAccessLink(window.location.href) || { endpoint: defaultEndpoint(), token: '' };
    var explicitToken = initial.token || '';
    state.endpoint = initial.endpoint;
    var savedRemoteToken = explicitToken || readSavedToken(state.endpoint);
    state.token = explicitToken;
    state.localAccess = originOf(state.endpoint) === window.location.origin;
    if (state.token && !state.localAccess) updateUrlToken();
    setInterval(function () {
      document.querySelectorAll('[data-activity-at]').forEach(function (node) { node.textContent = formatAge((Date.now() - Date.parse(node.dataset.activityAt)) / 1000); });
      document.querySelectorAll('[data-started-at]').forEach(function (node) { node.textContent = formatDuration((Date.now() - Date.parse(node.dataset.startedAt)) / 1000); });
    }, 1000);
    byId('searchInput').addEventListener('input', function (event) { state.search = event.target.value.toLowerCase().trim(); renderCards(); });
    byId('refreshButton').addEventListener('click', requestSnapshot);
    if (byId('connectButton')) byId('connectButton').addEventListener('click', connectFromInput);
    if (explicitToken) markCopyReady();
    else markCopyWaiting('Preparing private Android link…');
    byId('copyButton').addEventListener('click', function () {
      var button = byId('copyButton');
      if (!state.token) {
        button.textContent = 'Preparing link…';
        accessTokenForCopy().then(function () {
          button.textContent = 'Copy access link';
          setCopyStatus('Ready — tap Copy access link now', 'ready');
        }).catch(function () {
          button.textContent = 'Copy access link';
        });
        return;
      }
      // Do not await network work in the click handler. The token is prepared
      // while the connection is established, preserving browser click
      // activation for navigator.clipboard.writeText and the fallback.
      var link = buildAccessLink();
      button.disabled = true;
      button.textContent = 'Copying…';
      copyText(link).then(function () {
        button.textContent = 'Copied';
        setCopyStatus('Copied for Android · link is ready to paste', 'ready');
        setTimeout(function () { button.textContent = 'Copy access link'; button.disabled = false; }, 1800);
      }).catch(function (error) {
        button.textContent = 'Copy access link';
        button.disabled = false;
        markCopyUnavailable('Clipboard was blocked — allow clipboard access and retry');
        setNotice('Could not copy the private access link: ' + error.message);
      });
    });
    setConnectPanel(false);
    // A page served by the local monitor is already on the exact port chosen
    // by START. Do not briefly probe a stale configured hint (for example a
    // previous free port) before rendering this PC's live wall.
    if (!explicitToken && isLocalWallPage()) {
      state.endpoint = window.location.origin;
      state.token = '';
      state.localAccess = true;
      state.localProbe = false;
      var bootstrapped = useBootstrapSnapshot();
      if (bootstrapped) {
        connectEvents();
      } else {
        requestSnapshot().then(connectEvents);
      }
      return;
    }
    // A browser on the PC may have a previously saved remote token. The local
    // monitor is still the authoritative default there, so make one quick
    // local attempt before using that token. Explicit access URLs continue to
    // mean exactly what the user asked for and skip the local-first branch.
    if (!explicitToken && configuredLocalEndpoint()) {
      state.localFirst = true;
      state.token = '';
      state.localAccess = false;
      setConnection('Looking for this PC', 'connection-reconnecting');
      setNotice('Connecting to this PC automatically.');
      probeLocalEndpoint(true).then(function (connected) {
        if (connected) {
          connectEvents();
          return;
        }
        if (!savedRemoteToken) return;
        cancelLocalProbeRetry();
        state.endpoint = initial.endpoint;
        state.token = savedRemoteToken;
        state.localAccess = false;
        requestSnapshot(true).then(connectEvents);
      });
    } else if (!state.token && !state.localAccess) {
      setConnection('Looking for this PC', 'connection-reconnecting');
      setNotice('Connecting to this PC automatically.');
      probeLocalEndpoint().then(function (connected) { if (connected) connectEvents(); });
    } else {
      requestSnapshot(Boolean(state.token && !state.localAccess)).then(connectEvents);
    }
  }

  document.addEventListener('DOMContentLoaded', setup);
}());
