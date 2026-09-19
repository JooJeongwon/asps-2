import { HttpError } from "../lib/errors";

const APP_HTML = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="same-origin">
  <title>ASPS · Daily snippets</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; color: #17202a; background: #f5f7fa; }
    * { box-sizing: border-box; }
    body { max-width: 1100px; margin: 0 auto; padding: 24px; }
    header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-bottom: 24px; }
    h1, h2, h3 { margin: 0 0 12px; }
    h1 { font-size: 1.6rem; }
    h2 { font-size: 1.15rem; }
    h3 { font-size: 1rem; }
    section, form, .card { background: white; border: 1px solid #dce2e8; border-radius: 12px; padding: 16px; }
    section { margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
    label { display: grid; gap: 6px; margin: 10px 0; font-size: .9rem; }
    input, select, button { font: inherit; border: 1px solid #b8c2cc; border-radius: 7px; padding: 9px 10px; }
    button { cursor: pointer; background: #17202a; color: white; border-color: #17202a; }
    button.secondary { background: white; color: #17202a; }
    button:disabled { cursor: not-allowed; opacity: .5; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .muted { color: #687684; font-size: .88rem; }
    .status { font-weight: 650; }
    .ok { color: #087443; }
    .warn { color: #9a5b00; }
    .error { color: #b42318; }
    #message { min-height: 1.4em; margin: 8px 0 16px; }
    .job { display: grid; gap: 8px; border-top: 1px solid #edf0f2; padding: 12px 0; }
    .job:first-child { border-top: 0; padding-top: 0; }
    .steps { display: flex; flex-wrap: wrap; gap: 5px; }
    .step { border-radius: 999px; padding: 3px 8px; background: #edf0f2; color: #687684; font-size: .78rem; }
    .step.done { background: #d7f5e5; color: #087443; }
    .step.failed { background: #fde2e1; color: #b42318; }
    code { word-break: break-all; }
  </style>
</head>
<body>
  <header>
    <div><h1>ASPS</h1><div class="muted">사용자별 Daily snippet 자동화</div></div>
    <div class="row"><button id="refresh" class="secondary" type="button">새로고침</button><button id="logout" class="secondary" type="button">로그아웃</button></div>
  </header>
  <div id="message" role="status" aria-live="polite"></div>

  <section>
    <h2>내 계정</h2>
    <div id="account" class="muted">불러오는 중…</div>
  </section>

  <section>
    <h2>연결</h2>
    <div id="connections" class="grid"></div>
    <div class="grid" style="margin-top:12px">
      <form id="notion-form">
        <h3>Notion 연결</h3>
        <label>Integration token<input name="token" type="password" autocomplete="new-password" required></label>
        <label>Database ID<input name="databaseId" required></label>
        <label>Data source ID<input name="dataSourceId" required></label>
        <label>Workspace 참조<input name="workspaceRef"></label>
        <label>제목 property<input name="title" value="제목"></label>
        <label>날짜 property<input name="date" value="날짜" required></label>
        <label>상태 property<input name="status" value="상태" required></label>
        <label>ASPS job ID property<input name="jobId" value="ASPS Job ID"></label>
        <label>1000.school ID property<input name="remoteId" value="1000school ID"></label>
        <label>AI 제안 property<input name="suggestion" value="AI 제안"></label>
        <label>AI 채점/피드백 property<input name="score" value="AI 피드백"></label>
        <label>마지막 오류 property<input name="lastError" value="마지막 오류"></label>
        <div class="row"><button type="submit">저장</button><button class="secondary" data-disconnect="notion" type="button">연결 해제</button></div>
      </form>
      <form id="school-form">
        <h3>1000.school 연결</h3>
        <label>API token<input name="token" type="password" autocomplete="new-password" required></label>
        <label>Provider account 참조<input name="providerAccountRef"></label>
        <label>만료 시각<input name="expiresAt" type="datetime-local"></label>
        <div class="row"><button type="submit">저장</button><button class="secondary" data-disconnect="thousand-school" type="button">연결 해제</button></div>
      </form>
    </div>
  </section>

  <section>
    <h2>Automation profile</h2>
    <form id="profile-form">
      <div class="grid">
        <label>이름<input name="name" required maxlength="120"></label>
        <label>기본 실행 단계<select name="defaultMode"><option selected>FULL_AUTO</option><option>DRAFT_ONLY</option><option>SUGGEST</option><option>SCORE</option><option>SAVE</option></select></label>
        <label>Notion connection<select name="notionConnectionId" required></select></label>
        <label>1000.school account<select name="thousandSchoolAccountId" required></select></label>
      </div>
      <button id="profile-submit" type="submit">Profile 생성</button>
    </form>
    <div id="profiles" style="margin-top:12px"></div>
  </section>

  <section>
    <div class="row" style="justify-content:space-between"><h2>Jobs</h2><span class="muted">Notion의 전송대기 page를 동기화하면 생성됩니다.</span></div>
    <div id="jobs" class="muted">불러오는 중…</div>
    <div id="job-detail" style="margin-top:12px"></div>
  </section>

  <script>
    const state = { me: null, jobs: [], csrf: '' };
    const $ = (selector) => document.querySelector(selector);
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
    const setMessage = (message, kind) => { const node = $('#message'); node.textContent = message || ''; node.className = kind || ''; };
    const api = async (path, options) => {
      const init = options || {};
      const headers = Object.assign({ 'content-type': 'application/json' }, init.headers || {});
      if (init.method && init.method !== 'GET' && state.csrf) headers['x-csrf-token'] = state.csrf;
      const response = await fetch(path, Object.assign({}, init, { headers }));
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!response.ok) throw new Error((data && data.error && data.error.message) || '요청에 실패했습니다.');
      return data;
    };
    const connectionLabel = (name, connection) => {
      if (!connection) return '<div class="card"><h3>' + name + '</h3><span class="muted">연결되지 않음</span></div>';
      return '<div class="card"><h3>' + name + '</h3><div class="status ' + (connection.status === 'ACTIVE' ? 'ok' : 'warn') + '">' + escapeHtml(connection.status) + '</div><div class="muted">ID <code>' + escapeHtml(connection.id) + '</code></div><div class="muted">Credential ' + escapeHtml(connection.credentialStatus) + '</div></div>';
    };
    const stageNames = ['PENDING', 'FETCHED', 'DRAFT_CREATED', 'AI_SUGGESTED', 'AI_SCORED', 'SAVED'];
    const renderJobs = () => {
      if (!state.jobs.length) { $('#jobs').textContent = '아직 job이 없습니다.'; return; }
      $('#jobs').innerHTML = state.jobs.map((job) => {
        const index = stageNames.indexOf(job.status);
        const steps = stageNames.map((stage, stepIndex) => '<span class="step ' + (stepIndex <= index ? 'done' : '') + '">' + stage + '</span>').join('');
        const failure = job.lastErrorCode ? '<div class="error">' + escapeHtml(job.lastErrorCode) + ': ' + escapeHtml(job.lastErrorMessage) + '</div>' : '';
        const retry = ['FAILED_RETRYABLE', 'FAILED_FINAL', 'AUTH_REQUIRED'].includes(job.status) ? '<button class="secondary" data-retry-job="' + escapeHtml(job.id) + '" type="button">실패 단계 재시도</button>' : '';
        const actions = job.status === 'SAVED' || job.status === 'CANCELLED' ? '' : '<button class="secondary" data-job-action="SUGGEST" data-job-id="' + escapeHtml(job.id) + '" type="button">AI 제안</button><button class="secondary" data-job-action="SCORE" data-job-id="' + escapeHtml(job.id) + '" type="button">AI 채점</button><button data-job-action="SAVE" data-job-id="' + escapeHtml(job.id) + '" type="button">저장</button>';
        return '<article class="job"><div class="row"><strong>' + escapeHtml(job.status) + '</strong><span class="muted">' + escapeHtml(job.targetDate) + '</span><span class="muted">page <code>' + escapeHtml(job.notionPageId) + '</code></span><button class="secondary" data-job-detail="' + escapeHtml(job.id) + '" type="button">상세</button>' + actions + retry + '<button class="secondary" data-delete-job="' + escapeHtml(job.id) + '" type="button">삭제</button></div><div class="steps">' + steps + '</div>' + failure + '</article>';
      }).join('');
    };
    const showJobDetail = async (jobId) => { setMessage('job 상세를 불러오는 중…'); try { const job = await api('/api/jobs/' + encodeURIComponent(jobId)); const steps = (job.steps || []).map((step) => '<li><strong>' + escapeHtml(step.stage) + '</strong> · ' + escapeHtml(step.status) + ' · 시도 ' + escapeHtml(step.attemptCount) + (step.safeErrorCode ? ' · ' + escapeHtml(step.safeErrorCode) : '') + (step.outputRef ? '<pre>' + escapeHtml(step.outputRef) + '</pre>' : '') + '</li>').join(''); $('#job-detail').innerHTML = '<div class="card"><h3>Job 상세</h3><div class="muted"><code>' + escapeHtml(job.id) + '</code> · ' + escapeHtml(job.status) + '</div><ol>' + (steps || '<li>단계 정보가 없습니다.</li>') + '</ol></div>'; setMessage(''); } catch (error) { setMessage(error.message, 'error'); } };
    const render = () => {
      const me = state.me;
      $('#account').innerHTML = '<span class="status">' + escapeHtml(me.user.displayName || me.user.email || me.user.id) + '</span> · ' + escapeHtml(me.user.status);
      $('#connections').innerHTML = connectionLabel('Notion', me.notion) + connectionLabel('1000.school', me.thousandSchool);
      const notionSelect = $('#profile-form [name="notionConnectionId"]');
      const schoolSelect = $('#profile-form [name="thousandSchoolAccountId"]');
      notionSelect.innerHTML = me.notion ? '<option value="' + escapeHtml(me.notion.id) + '">' + escapeHtml(me.notion.id) + '</option>' : '<option value="">Notion 연결 필요</option>';
      schoolSelect.innerHTML = me.thousandSchool ? '<option value="' + escapeHtml(me.thousandSchool.id) + '">' + escapeHtml(me.thousandSchool.id) + '</option>' : '<option value="">1000.school 연결 필요</option>';
      notionSelect.disabled = !me.notion; schoolSelect.disabled = !me.thousandSchool;
      $('#profile-form button[type="submit"]').disabled = !me.notion || !me.thousandSchool;
      $('#profiles').innerHTML = me.profiles.length ? me.profiles.map((profile) => '<div class="card row" style="justify-content:space-between;margin-top:8px"><span><strong>' + escapeHtml(profile.name) + '</strong> · ' + escapeHtml(profile.defaultMode) + ' · ' + (profile.enabled ? '<span class="ok">활성</span>' : '<span class="warn">비활성</span>') + '</span><span class="row"><button class="secondary" data-edit-profile="' + escapeHtml(profile.id) + '" type="button">수정</button>' + (profile.enabled ? '<button class="secondary" data-sync-profile="' + escapeHtml(profile.id) + '" type="button">동기화</button><button class="secondary" data-disable-profile="' + escapeHtml(profile.id) + '" type="button">비활성화</button>' : '<button class="secondary" data-enable-profile="' + escapeHtml(profile.id) + '" type="button">활성화</button>') + '<button class="secondary" data-delete-profile="' + escapeHtml(profile.id) + '" type="button">삭제</button></span></div>').join('') : '<span class="muted">아직 profile이 없습니다.</span>';
      renderJobs();
    };
    const load = async () => { setMessage('불러오는 중…'); try { const values = await Promise.all([api('/api/me'), api('/api/jobs?limit=50'), api('/api/auth/csrf')]); state.me = values[0]; state.jobs = values[1]; state.csrf = values[2].token; render(); setMessage(''); } catch (error) { setMessage(error.message, 'error'); } };
    $('#notion-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); data.propertyMapping = { title: data.title, date: data.date, status: data.status, jobId: data.jobId, remoteId: data.remoteId, suggestion: data.suggestion, score: data.score, lastError: data.lastError }; delete data.title; delete data.date; delete data.status; delete data.jobId; delete data.remoteId; delete data.suggestion; delete data.score; delete data.lastError; setMessage('저장 중…'); try { await api('/api/me/connections/notion', { method: 'PUT', body: JSON.stringify(data) }); form.reset(); setMessage('Notion 연결을 저장했습니다.', 'ok'); await load(); } catch (error) { setMessage(error.message, 'error'); } });
    $('#school-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); if (data.expiresAt) data.expiresAt = new Date(data.expiresAt).toISOString(); else delete data.expiresAt; setMessage('저장 중…'); try { await api('/api/me/connections/thousand-school', { method: 'PUT', body: JSON.stringify(data) }); form.reset(); setMessage('1000.school 연결을 저장했습니다.', 'ok'); await load(); } catch (error) { setMessage(error.message, 'error'); } });
    $('#profile-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const editId = form.dataset.editId; const data = Object.fromEntries(new FormData(form)); setMessage('저장 중…'); try { await api(editId ? '/api/me/automation-profiles/' + encodeURIComponent(editId) : '/api/me/automation-profiles', { method: editId ? 'PUT' : 'POST', body: JSON.stringify(data) }); form.reset(); delete form.dataset.editId; $('#profile-submit').textContent = 'Profile 생성'; setMessage('Profile을 저장했습니다.', 'ok'); await load(); } catch (error) { setMessage(error.message, 'error'); } });
    $('#refresh').addEventListener('click', load);
    $('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login'; });
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const disconnect = button.dataset.disconnect;
      if (disconnect) { if (!confirm('이 연결을 해제할까요?')) return; try { await api('/api/me/connections/' + disconnect, { method: 'DELETE' }); setMessage('연결을 해제했습니다.', 'ok'); await load(); } catch (error) { setMessage(error.message, 'error'); } return; }
      const profileId = button.dataset.disableProfile;
      if (profileId) { if (!confirm('이 profile을 비활성화할까요?')) return; try { await api('/api/me/automation-profiles/' + encodeURIComponent(profileId), { method: 'PUT', body: JSON.stringify({ enabled: false }) }); setMessage('Profile을 비활성화했습니다.', 'ok'); await load(); } catch (error) { setMessage(error.message, 'error'); } return; }
      const enableProfileId = button.dataset.enableProfile;
      if (enableProfileId) { try { await api('/api/me/automation-profiles/' + encodeURIComponent(enableProfileId), { method: 'PUT', body: JSON.stringify({ enabled: true }) }); setMessage('Profile을 활성화했습니다.', 'ok'); await load(); } catch (error) { setMessage(error.message, 'error'); } return; }
      const deleteProfileId = button.dataset.deleteProfile;
      if (deleteProfileId) { if (!confirm('이 profile과 연결된 job을 모두 삭제할까요?')) return; try { await api('/api/me/automation-profiles/' + encodeURIComponent(deleteProfileId), { method: 'DELETE' }); setMessage('Profile을 삭제했습니다.', 'ok'); await load(); } catch (error) { setMessage(error.message, 'error'); } return; }
      const editProfileId = button.dataset.editProfile;
      if (editProfileId) { const profile = state.me.profiles.find((item) => item.id === editProfileId); if (!profile) return; const form = $('#profile-form'); form.dataset.editId = profile.id; form.elements.name.value = profile.name; form.elements.defaultMode.value = profile.defaultMode; form.elements.notionConnectionId.value = profile.notionConnectionId; form.elements.thousandSchoolAccountId.value = profile.thousandSchoolAccountId; $('#profile-submit').textContent = 'Profile 수정'; form.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      const jobId = button.dataset.jobDetail;
      if (jobId) { await showJobDetail(jobId); return; }
      const deleteJobId = button.dataset.deleteJob;
      if (deleteJobId) { if (!confirm('이 job을 삭제할까요?')) return; try { await api('/api/jobs/' + encodeURIComponent(deleteJobId), { method: 'DELETE' }); setMessage('Job을 삭제했습니다.', 'ok'); await load(); } catch (error) { setMessage(error.message, 'error'); } return; }
      const retryId = button.dataset.retryJob;
      if (retryId) { setMessage('재시도 중…'); try { await api('/api/jobs/' + encodeURIComponent(retryId) + '/retry', { method: 'POST' }); setMessage('재시도를 등록했습니다.', 'ok'); await load(); } catch (error) { setMessage(error.message, 'error'); } return; }
      const action = button.dataset.jobAction;
      const actionJobId = button.dataset.jobId;
      if (action && actionJobId) { if (action === 'SAVE' && !confirm('AI 제안 내용을 1000.school에 저장할까요?')) return; button.disabled = true; setMessage(action + ' 실행을 등록하는 중…'); try { await api('/api/jobs/' + encodeURIComponent(actionJobId) + '/action', { method: 'POST', body: JSON.stringify({ action }) }); setMessage(action + ' 실행을 등록했습니다.', 'ok'); await load(); } catch (error) { setMessage(error.message, 'error'); button.disabled = false; } return; }
      const syncId = button.dataset.syncProfile;
      if (syncId) { setMessage('Notion을 동기화 중…'); try { const result = await api('/api/sync/notion', { method: 'POST', body: JSON.stringify({ profileId: syncId }) }); const warnings = (result.warnings || []).slice(0, 5).map((item) => item.code).join(', '); const detail = '스캔 ' + result.scanned + ' · 건너뜀 ' + result.skipped + ' · 기존 ' + result.existing + (warnings ? ' · ' + warnings : ''); setMessage('동기화 완료 · ' + result.queued + '개 job 등록 (' + detail + ')', result.queued ? 'ok' : 'warn'); await load(); } catch (error) { setMessage(error.message, 'error'); } }
    });
    load();
  </script>
</body>
</html>`;

export function handleApp(request: Request): Response {
  if (request.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  return new Response(APP_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    },
  });
}
