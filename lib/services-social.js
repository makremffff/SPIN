'use strict';
/**
 * lib/services-social.js
 * Handlers للمهام الاجتماعية — مستقل لا يمس باقي السيرفيسز
 */

const { sql } = require('./db');

/* ── GET active social tasks + user status ─────────────────── */
async function handleSocialGetTasks(userId) {
  const tasks = await sql(
    `SELECT id, title, description, reward, icon, note, promo_text,
            promo_optional, task_url, proof_required
     FROM social_tasks
     WHERE is_active = TRUE
     ORDER BY sort_order, id`
  );

  if (!tasks.length) return { ok: true, tasks: [] };

  // جلب حالة المستخدم لهذه المهام
  const proofs = await sql(
    `SELECT task_id, status FROM social_proofs WHERE user_id = $1`,
    [userId]
  );
  const proofMap = {};
  for (const p of proofs) proofMap[p.task_id] = p.status;

  const result = tasks.map(t => ({
    ...t,
    reward: Number(t.reward),
    user_status: proofMap[t.id] || 'idle', // idle | pending | approved | rejected
  }));

  return { ok: true, tasks: result };
}

/* ── SUBMIT proof image ────────────────────────────────────── */
async function handleSocialSubmitProof(userId, body) {
  const taskId = Number(body?.task_id);
  if (!taskId) return { ok: false, error: 'missing_task_id' };

  // تحقق من المهمة
  const [task] = await sql(
    `SELECT id, proof_required, reward FROM social_tasks WHERE id = $1 AND is_active = TRUE`,
    [taskId]
  );
  if (!task) return { ok: false, error: 'task_not_found' };

  // تحقق من التكرار
  const [existing] = await sql(
    `SELECT id, status FROM social_proofs WHERE user_id = $1 AND task_id = $2`,
    [userId, taskId]
  );
  if (existing) return { ok: false, error: 'already_submitted' };

  // حفظ الصورة — نحفظ base64 في حقل proof_image
  // في الإنتاج يُستبدل بـ upload إلى storage مثل S3
  const proofImage = task.proof_required ? (body?.proof_image || '') : '';

  await sql(
    `INSERT INTO social_proofs(user_id, task_id, proof_image, status)
     VALUES($1, $2, $3, 'pending')`,
    [userId, taskId, proofImage]
  );

  return { ok: true, status: 'pending' };
}

/* ── ADMIN: get pending proofs ─────────────────────────────── */
async function handleSocialAdminGetProofs(body) {
  const status = body?.status || 'pending';
  const limit  = Math.min(Number(body?.limit) || 50, 100);
  const offset = Number(body?.offset) || 0;

  const proofs = await sql(
    `SELECT sp.id, sp.user_id, sp.task_id, sp.proof_image,
            sp.status, sp.created_at,
            u.first_name, u.username,
            st.title AS task_title, st.reward
     FROM social_proofs sp
     JOIN users        u  ON u.id  = sp.user_id
     JOIN social_tasks st ON st.id = sp.task_id
     WHERE sp.status = $1
     ORDER BY sp.created_at ASC
     LIMIT $2 OFFSET $3`,
    [status, limit, offset]
  );

  const [{ cnt }] = await sql(
    `SELECT COUNT(*) AS cnt FROM social_proofs WHERE status = $1`,
    [status]
  );

  return { ok: true, proofs, total: Number(cnt), limit, offset };
}

/* ── ADMIN: approve / reject proof ────────────────────────── */
async function handleSocialAdminReview(body) {
  const proofId = Number(body?.proof_id);
  const action  = body?.action; // 'approve' | 'reject'
  const reviewer = body?.reviewer || 'admin';

  if (!proofId || !['approve', 'reject'].includes(action)) {
    return { ok: false, error: 'invalid_params' };
  }

  const [proof] = await sql(
    `SELECT sp.id, sp.user_id, sp.status, st.reward
     FROM social_proofs sp
     JOIN social_tasks  st ON st.id = sp.task_id
     WHERE sp.id = $1`,
    [proofId]
  );
  if (!proof) return { ok: false, error: 'proof_not_found' };
  if (proof.status !== 'pending') return { ok: false, error: 'already_reviewed' };

  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  // FIX-3: تغليف العملية في transaction — كانت جملتان منفصلتان تسببان فقدان النقاط لو وقع السيرفر بينهما
  await sql(`BEGIN`);
  try {
    await sql(
      `UPDATE social_proofs
       SET status = $1, reviewed_by = $2, reviewed_at = NOW()
       WHERE id = $3`,
      [newStatus, reviewer, proofId]
    );

    if (action === 'approve') {
      await sql(
        `UPDATE users SET balance = balance + $1 WHERE id = $2`,
        [proof.reward, proof.user_id]
      );
    }
    await sql(`COMMIT`);
  } catch (err) {
    await sql(`ROLLBACK`);
    throw err;
  }

  return { ok: true, proof_id: proofId, new_status: newStatus };
}

/* ── ADMIN: manage tasks (add / edit / delete) ─────────────── */
async function handleSocialAdminTasks(body) {
  const action = body?.action;

  if (action === 'list') {
    const tasks = await sql(`SELECT * FROM social_tasks ORDER BY sort_order, id`);
    return { ok: true, tasks };
  }

  if (action === 'add') {
    const d = body?.data || {};
    const [row] = await sql(
      `INSERT INTO social_tasks(title, description, reward, icon, note, promo_text, promo_optional, task_url, proof_required, sort_order)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [d.title||'', d.description||'', Number(d.reward)||100, d.icon||'default',
       d.note||'', d.promo_text||'', d.promo_optional!==false,
       d.task_url||'', d.proof_required!==false, Number(d.sort_order)||0]
    );
    return { ok: true, id: row.id };
  }

  if (action === 'edit') {
    const d = body?.data || {};
    if (!d.id) return { ok: false, error: 'missing_id' };
    await sql(
      `UPDATE social_tasks SET
         title=$1, description=$2, reward=$3, icon=$4, note=$5,
         promo_text=$6, promo_optional=$7, task_url=$8, proof_required=$9,
         sort_order=$10, is_active=$11
       WHERE id=$12`,
      [d.title, d.description, Number(d.reward), d.icon, d.note,
       d.promo_text, d.promo_optional!==false, d.task_url,
       d.proof_required!==false, Number(d.sort_order)||0, d.is_active!==false, d.id]
    );
    return { ok: true };
  }

  if (action === 'delete') {
    if (!body?.id) return { ok: false, error: 'missing_id' };
    await sql(`DELETE FROM social_tasks WHERE id = $1`, [body.id]);
    return { ok: true };
  }

  return { ok: false, error: 'unknown_action' };
}

module.exports = {
  handleSocialGetTasks,
  handleSocialSubmitProof,
  handleSocialAdminGetProofs,
  handleSocialAdminReview,
  handleSocialAdminTasks,
};
