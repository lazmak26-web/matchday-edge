async function loadAdmin() {
  if (!isAdmin()) return;
  $('adminMsg').textContent = '';
  try {
    const [uRes, sRes] = await Promise.all([
      fetch('/api/admin/users', { headers: { 'Authorization': 'Bearer ' + authState.token } }),
      fetch('/api/admin/stats', { headers: { 'Authorization': 'Bearer ' + authState.token } })
    ]);

    if (sRes.ok) {
      const sData = await sRes.json();
      $('siteStats').innerHTML = `
        <div class="perf-card"><div class="perf-val" style="color:var(--good)">${sData.liveUsers}</div><div class="perf-lbl">Users Online Now</div></div>
        <div class="perf-card"><div class="perf-val" style="color:var(--brand)">${sData.totalVisits}</div><div class="perf-lbl">Total Site Visits</div></div>
      `;
    }

    if (!uRes.ok) throw new Error('HTTP ' + uRes.status);
    const d = await uRes.json();
    adminUsers = d.users || [];
    $('adminStats').innerHTML = [['Total users', d.total, 'var(--ink-2)'], ['Pro', d.pro, 'var(--good)'], ['Free', d.free, 'var(--ink-3)']]
      .map(([l, v, c]) => `<div class="perf-card"><div class="perf-val" style="color:${c}">${Number(v) || 0}</div><div class="perf-lbl">${l}</div></div>`).join('');
    renderAdmin();
  } catch (e) { $('adminMsg').textContent = 'Could not load admin data (' + e.message + ').'; }
}