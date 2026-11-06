// מעבר למצב מאובטח / חזרה אחורה. רץ מתוך GitHub Actions עם חשבון השירות.
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'g-room-escape-room-management' });
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const db = getFirestore(admin.app(), 'groom');
const mode = process.argv[2];
(async () => {
  const g = db.collection('app_settings').doc('global'); const sec = db.collection('admin_secrets').doc('main');
  if (mode === 'copy') { // שלב 1: העתקה בלבד (שום דבר לא נמחק)
    const gs = await g.get(); const gd = gs.exists ? gs.data() : {};
    const upd = {}; if (gd.adminCode) upd.adminCode = gd.adminCode; if (gd.t4yWebhookSecret) upd.t4yWebhookSecret = gd.t4yWebhookSecret;
    if (Object.keys(upd).length) await sec.set(upd, { merge: true });
    const emps = await db.collection('employees').get(); let n = 0;
    for (const d of emps.docs) { const c = d.data().code; if (c !== undefined && c !== null && String(c) !== '') { await db.collection('employee_codes').doc(d.id).set({ code: String(c) }); n++; } }
    console.log('copied codes:', n, 'secrets:', Object.keys(upd));
  } else if (mode === 'finish') { // שלב 3: מחיקת הקודים מהמקומות הגלויים והפעלת המצב המאובטח
    const emps = await db.collection('employees').get();
    for (const d of emps.docs) if (d.data().code !== undefined) await d.ref.update({ code: FieldValue.delete() });
    await g.set({ adminCode: FieldValue.delete(), t4yWebhookSecret: FieldValue.delete() }, { merge: true });
    await sec.set({ secureMode: true }, { merge: true });
    console.log('secure mode ON');
  } else if (mode === 'rollback') { // החזרת הקודים ובטל מצב מאובטח
    const codes = await db.collection('employee_codes').get();
    for (const d of codes.docs) await db.collection('employees').doc(d.id).set({ code: d.data().code }, { merge: true });
    const s = await sec.get(); const sd = s.exists ? s.data() : {};
    const back = {}; if (sd.adminCode) back.adminCode = sd.adminCode; if (sd.t4yWebhookSecret) back.t4yWebhookSecret = sd.t4yWebhookSecret;
    if (Object.keys(back).length) await g.set(back, { merge: true });
    await sec.set({ secureMode: false }, { merge: true });
    console.log('secure mode OFF, codes restored');
  } else throw new Error('mode?');
})().catch(e => { console.error(e); process.exit(1); });
