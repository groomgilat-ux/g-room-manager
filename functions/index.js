const functions = require("firebase-functions");
const cors = require("cors")({ origin: true });
const https = require("https");
const querystring = require("querystring");
const admin = require("firebase-admin");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
admin.initializeApp({ storageBucket: 'g-room-escape-room-management.firebasestorage.app' });
const gdb = () => getFirestore(admin.app(), "groom"); // מסד הנתונים הנקרא groom

const torkey = "__TOR4YOU_KEY__"; // מוזרק בזמן הפריסה מ-GitHub Secrets

// ערכי ברירת מחדל מתוך המערכת
const DEFAULT_SERVICE_ID = "131709"; // חדר בריחה
const DEFAULT_STAFF_ID = "71958"; // סודו של הודיני

// מטמון קצר לקריאות קריאה (GET) כדי לא לעבור את מגבלת הבקשות של Tor4You. כל כתיבה מנקה אותו.
const t4yCache = new Map();
const fetchTor4You = (path, method = 'GET', postData = null, contentType = 'application/json') => {
    if (method === 'GET') {
        const hit = t4yCache.get(path);
        if (hit && Date.now() - hit.t < 20000) return hit.p;
        const p = fetchTor4YouRaw(path, method, postData, contentType);
        t4yCache.set(path, { t: Date.now(), p });
        p.then(r => { if (r && (r.error || /rate limit/i.test(JSON.stringify(r)))) t4yCache.delete(path); }, () => t4yCache.delete(path));
        return p;
    }
    t4yCache.clear();
    return fetchTor4YouRaw(path, method, postData, contentType).then(r => { t4yCache.clear(); return r; });
};
const fetchTor4YouRaw = (path, method = 'GET', postData = null, contentType = 'application/json') => {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'www.tor4you.co.il', port: 443, path: path, method: method,
            headers: { 'torkey': torkey, 'User-Agent': 'Mozilla/5.0' }
        };
        if (postData) {
            options.headers['Content-Type'] = contentType;
            options.headers['Content-Length'] = Buffer.byteLength(postData);
        }
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } 
                catch(e) { resolve({ error: 'Parse error', raw: data }); }
            });
        });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
    });
};

exports.getTor4YouAppts = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        const dateStr = req.query.date; 
        if (!dateStr) return res.status(400).json({ error: "Missing date parameter" });
        const formattedDate = dateStr.replace(/-/g, '');
        try {
            const parsedData = await fetchTor4You(`/api/apptlist?from=${formattedDate}&to=${formattedDate}`);
            if (parsedData.status == 1 || parsedData.status === "1") {
                 const uniqueCustomers = []; const namesSet = new Set();
                 (parsedData.appts || []).forEach(appt => {
                     const fullName = `${appt.first || ''} ${appt.last || ''}`.trim();
                     let timeStr = "10:00";
                     if (appt.from && appt.from.length >= 12) timeStr = `${appt.from.substring(8, 10)}:${appt.from.substring(10, 12)}`;
                     const players = Number(appt.parts || appt.participants || appt.qty || 2);
                     if(fullName && !namesSet.has(fullName)) {
                         namesSet.add(fullName);
                         uniqueCustomers.push({ name: fullName, time: timeStr, players });
                     }
                 });
                 return res.status(200).json({ customers: uniqueCustomers });
            } else return res.status(200).json({ customers: [], debugInfo: parsedData });
        } catch (e) { return res.status(500).json({ error: e.message }); }
    });
});

exports.getTor4YouWeekSlots = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        const { fromDate, toDate } = req.query; 
        if (!fromDate || !toDate) return res.status(400).json({ error: "Missing dates" });
        try {
            const apptlist = await fetchTor4You(`/api/apptlist?from=${fromDate}&to=${toDate}&format=2`);
            const apptsMap = {};
            if (apptlist.status == 1 && apptlist.appts) {
                apptlist.appts.forEach(a => {
                    if (a.from && a.from.length >= 12) {
                        apptsMap[a.from] = { 
                            name: `${a.first||''} ${a.last||''}`.trim(), 
                            phone: a.cell || a.phone || '', 
                            participants: Number(a.parts || a.participants || a.qty || 2) 
                        };
                    }
                });
            }

            const slotlist = await fetchTor4You(`/api/slotlist?from=${fromDate}&to=${toDate}`);
            // אם Tor4You דחה את הבקשה (מגבלת בקשות וכד'), מחזירים שגיאה ולא "יומן ריק" שיגרום לסנכרון שגוי
            const failed = [apptlist, slotlist].find(r => r && (r.error || /rate limit/i.test(JSON.stringify(r))));
            if (failed) return res.status(503).json({ error: (failed.message || failed.error || JSON.stringify(failed)).toString().slice(0, 200) });
            const slotsMap = {};
            
            if (apptlist.status == 1 && apptlist.appts) {
                apptlist.appts.forEach(a => {
                    if (a.from && a.from.length >= 12) {
                        const datePart = a.from.substring(0, 8);
                        const formattedDate = `${datePart.substring(0,4)}-${datePart.substring(4,6)}-${datePart.substring(6,8)}`;
                        const timePart = a.from.substring(8, 12); 
                        const formattedTime = `${timePart.substring(0,2)}:${timePart.substring(2,4)}`;
                        
                        if (!slotsMap[formattedDate]) slotsMap[formattedDate] = [];
                        slotsMap[formattedDate].push({ 
                            time: formattedTime, id: null, vfib: null, 
                            staff: a.staff || DEFAULT_STAFF_ID, service: a.service || DEFAULT_SERVICE_ID, 
                            participants: Number(a.parts || a.participants || 2), 
                            customerName: `${a.first||''} ${a.last||''}`.trim(), customerPhone: a.cell || a.phone || '', 
                            isBooked: true, slotTo: a.to || '', customerEmail: a.email || ''
                        });
                    }
                });
            }

            if (slotlist.status == 1 && slotlist.slots) {
                slotlist.slots.forEach(slot => {
                    const datePart = slot.from.substring(0, 8);
                    const formattedDate = `${datePart.substring(0,4)}-${datePart.substring(4,6)}-${datePart.substring(6,8)}`;
                    const timePart = slot.from.substring(8, 12); 
                    const formattedTime = `${timePart.substring(0,2)}:${timePart.substring(2,4)}`;
                    
                    if (!slotsMap[formattedDate]) slotsMap[formattedDate] = [];
                    const existing = slotsMap[formattedDate].find(s => s.time === formattedTime);
                    
                    if (!existing) {
                        slotsMap[formattedDate].push({ 
                            time: formattedTime, id: slot.id, vfib: slot.vfib, 
                            staff: slot.staff || DEFAULT_STAFF_ID, service: slot.services || slot.service || DEFAULT_SERVICE_ID, 
                            participants: 0, customerName: '', customerPhone: '', isBooked: false,
                            slotTo: slot.to || '', maxmembers: slot.maxmembers || '', slotServices: slot.services || ''
                        });
                    } else {
                        existing.id = slot.id; existing.vfib = slot.vfib;
                        existing.slotTo = slot.to || existing.slotTo || ''; existing.maxmembers = slot.maxmembers || existing.maxmembers || '';
                        existing.staff = slot.staff || existing.staff;
                        existing.service = slot.services || slot.service || existing.service;
                    }
                });
            }
            
            for(let date in slotsMap) slotsMap[date].sort((a,b) => a.time.localeCompare(b.time));
            return res.status(200).json({ slotsMap });
        } catch (e) { return res.status(500).json({ error: e.message }); }
    });
});

const compactDate = (d) => String(d || '').replace(/-/g, '');
const addMinutesToStamp = (dateStr, timeStr, minutes) => {
    const [y, m, d] = compactDate(dateStr).match(/(\d{4})(\d{2})(\d{2})/).slice(1).map(Number);
    const [hh, mm] = String(timeStr).split(':').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d, hh, mm) + minutes * 60000);
    const p = (n) => String(n).padStart(2, '0');
    return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}`;
};

exports.deleteTor4YouSlots = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { slots } = req.body;
        if (!slots || !Array.isArray(slots)) return res.status(400).json({ error: 'Invalid slots array' });
        try {
            let deletedCount = 0; let errors = [];

            // SAFETY: never delete a slot that has an appointment. Verify against Tor4You itself when dates are provided.
            const dates = slots.map(s => compactDate(s.date)).filter(Boolean).sort();
            let protectedIds = new Set(); let protectedFroms = new Set(); let verified = false;
            if (dates.length > 0) {
                const from = dates[0]; const to = dates[dates.length - 1];
                const apptlist = await fetchTor4You(`/api/apptlist?from=${from}&to=${to}`);
                const slotlist = await fetchTor4You(`/api/slotlist?from=${from}&to=${to}&showappts=1`);
                if ((apptlist.status == 1) && (slotlist.status == 1)) {
                    verified = true;
                    (apptlist.appts || []).forEach(a => { if (a.slotid) protectedIds.add(String(a.slotid)); if (a.from) protectedFroms.add(String(a.from).substring(0, 12)); });
                    (slotlist.slots || []).forEach(sl => {
                        const hasAppts = Array.isArray(sl.appts) ? sl.appts.length > 0 : false;
                        if (hasAppts || protectedFroms.has(String(sl.from || '').substring(0, 12))) protectedIds.add(String(sl.id));
                    });
                }
                if (!verified) return res.status(502).json({ success: false, error: 'Could not verify slots against Tor4You - nothing was deleted', apptlist, slotlist });
            }

            for (const slot of slots) {
                if (!slot.slotid || !slot.vfib) { errors.push({ slot: slot.slotid, reason: 'missing slotid/vfib' }); continue; }
                if (protectedIds.has(String(slot.slotid))) { errors.push({ slot: slot.slotid, reason: 'has_appointment_not_deleted' }); continue; }
                const formBody = `slotid=${encodeURIComponent(slot.slotid)}&vfib=${encodeURIComponent(slot.vfib)}`;
                let response = await fetchTor4You('/api/delslot', 'POST', formBody, 'application/x-www-form-urlencoded');
                if (response.status != 1 && response.status !== "1") response = await fetchTor4You('/api/delslot', 'POST', JSON.stringify({ slotid: slot.slotid, vfib: slot.vfib }), 'application/json');
                if (response.status == 1 || response.status === "1") deletedCount++; else errors.push({ slot: slot.slotid, apiResponse: response });
            }
            return res.status(200).json({ success: true, deletedCount, errors });
        } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
    });
});

// Opens new free slots in Tor4You. Body: { slots: [{ date: 'YYYY-MM-DD', time: 'HH:MM' }], staff?, maxmembers?, services?, minutes? }
exports.addTor4YouSlots = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { slots } = req.body;
        if (!slots || !Array.isArray(slots) || slots.length === 0) return res.status(400).json({ error: 'Invalid slots array' });
        if (slots.length > 80) return res.status(400).json({ error: 'Too many slots in one request (max 80)' });
        const staff = (req.body.staff && String(req.body.staff) !== '0') ? String(req.body.staff) : DEFAULT_STAFF_ID;
        const minutes = Number(req.body.minutes) || 60;
        try {
            // Copy capacity (maxmembers) and services from existing slots so new ones behave like the current ones
            let maxmembers = req.body.maxmembers; let services = req.body.services;
            if (!maxmembers || services === undefined) {
                const dates = slots.map(s => compactDate(s.date)).sort();
                const probe = await fetchTor4You(`/api/slotlist?from=${dates[0]}&to=${dates[dates.length - 1]}`);
                let found = (probe.status == 1 && probe.slots && probe.slots.length) ? probe.slots : [];
                if (!found.length) {
                    const t = new Date(); const p = (n) => String(n).padStart(2, '0');
                    const f = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`;
                    const t2 = new Date(Date.now() + 30 * 864e5); const to = `${t2.getFullYear()}${p(t2.getMonth() + 1)}${p(t2.getDate())}`;
                    const probe2 = await fetchTor4You(`/api/slotlist?from=${f}&to=${to}`);
                    found = (probe2.status == 1 && probe2.slots) ? probe2.slots : [];
                }
                const sample = found.find(s => s.maxmembers && Number(s.maxmembers) > 0) || found[0];
                if (!maxmembers) maxmembers = sample && sample.maxmembers ? sample.maxmembers : 10;
                if (services === undefined) services = sample && sample.services !== undefined ? sample.services : 0;
            }

            let addedCount = 0; const errors = [];
            for (const s of slots) {
                if (!s.date || !s.time) { errors.push({ slot: s, reason: 'missing date/time' }); continue; }
                const from = addMinutesToStamp(s.date, s.time, 0);
                const to = addMinutesToStamp(s.date, s.time, minutes);
                const formData = querystring.stringify({ staff, from, to, services, maxmembers });
                const response = await fetchTor4You('/api/addslot', 'POST', formData, 'application/x-www-form-urlencoded');
                if (response.status == 1 || response.status === "1") addedCount++; else errors.push({ slot: `${s.date} ${s.time}`, apiResponse: response });
            }
            return res.status(200).json({ success: errors.length === 0, addedCount, errors, usedMaxMembers: maxmembers, usedServices: services });
        } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
    });
});

// Cancels ONE existing appointment (admin action). Body: { date: 'YYYY-MM-DD', time: 'HH:MM', sendnotice?: boolean }
// The appointment is looked up in Tor4You by its exact start time; if it is not found, or more than one match, nothing is deleted.
exports.deleteTor4YouAppointment = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { date, time, sendnotice } = req.body;
        if (!date || !time) return res.status(400).json({ success: false, error: 'Missing date/time' });
        try {
            const d = compactDate(date); const stamp = d + String(time).replace(':', '');
            const list = await fetchTor4You(`/api/apptlist?from=${d}&to=${d}&format=2`);
            if (!(list.status == 1)) return res.status(502).json({ success: false, error: 'Could not read appointments from Tor4You', raw: list });
            const matches = (list.appts || []).filter(a => String(a.from || '').substring(0, 12) === stamp);
            if (matches.length === 0) return res.status(404).json({ success: false, error: 'No appointment found at that time' });
            if (matches.length > 1) return res.status(409).json({ success: false, error: 'More than one appointment at that time - cancel it manually in Tor4You' });
            const a = matches[0];
            const apptid = a.id || a.apptid; let vfib = a.vfib;
            if (apptid && !vfib) { const info = await fetchTor4You(`/api/apptinfo?apptid=${encodeURIComponent(apptid)}`); vfib = (info && (info.vfib || (info.appt && info.appt.vfib))) || undefined; }
            if (!apptid || !vfib) return res.status(502).json({ success: false, error: 'Appointment id/vfib not available from Tor4You', fields: Object.keys(a) });
            const form = querystring.stringify({ apptid, vfib, sendnotice: sendnotice ? 1 : 0 });
            const response = await fetchTor4You('/api/delappt', 'POST', form, 'application/x-www-form-urlencoded');
            if (response.status == 1 || response.status === "1") return res.status(200).json({ success: true });
            return res.status(400).json({ success: false, error: JSON.stringify(response) });
        } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
    });
});

// Edits an existing appointment's details (Tor4You has no edit call, so: look up -> cancel -> re-create on the same slot).
// Everything is verified BEFORE anything is deleted, and if re-creating fails the original appointment is restored.
// Body: { date, time, first, last?, cell, email?, participants, sendnotice?: boolean }
exports.updateTor4YouAppointment = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { date, time, first, last, cell, email, participants, sendnotice } = req.body;
        if (!date || !time || !first || !cell) return res.status(400).json({ success: false, error: 'Missing date/time/first/cell' });
        try {
            const d = compactDate(date); const stamp = d + String(time).replace(':', '');
            const list = await fetchTor4You(`/api/apptlist?from=${d}&to=${d}&format=2`);
            if (!(list.status == 1)) return res.status(502).json({ success: false, error: 'Could not read appointments from Tor4You', raw: list });
            const matches = (list.appts || []).filter(a => String(a.from || '').substring(0, 12) === stamp);
            if (matches.length === 0) return res.status(404).json({ success: false, error: 'No appointment found at that time' });
            if (matches.length > 1) return res.status(409).json({ success: false, error: 'More than one appointment at that time - edit it manually in Tor4You' });
            const a = matches[0];
            const apptid = a.id || a.apptid; let vfib = a.vfib;
            if (apptid && !vfib) { const info = await fetchTor4You(`/api/apptinfo?apptid=${encodeURIComponent(apptid)}`); vfib = (info && (info.vfib || (info.appt && info.appt.vfib))) || undefined; }
            if (!apptid || !vfib) return res.status(502).json({ success: false, error: 'Appointment id/vfib not available from Tor4You', fields: Object.keys(a) });

            const findSlot = async () => {
                const sl = await fetchTor4You(`/api/slotlist?from=${d}&to=${d}`);
                return (sl.status == 1 ? (sl.slots || []) : []).find(s => String(s.from || '').substring(0, 12) === stamp);
            };
            const slot0 = await findSlot();
            if (!slot0) return res.status(404).json({ success: false, error: 'The slot of this appointment was not found - nothing was changed' });

            const original = { first: a.first || '', last: a.last || '', cell: a.cell || a.phone || '', email: a.email || '', participants: Number(a.parts || a.participants || a.qty || 2) };
            const cleanId = (v) => (v && String(v) !== '0') ? String(v) : undefined;
            const staff = cleanId(a.staff) || cleanId(slot0.staff) || DEFAULT_STAFF_ID;
            const service = cleanId(a.service) || DEFAULT_SERVICE_ID;
            const book = async (slot, det, notice) => fetchTor4You('/api/addappt', 'POST', querystring.stringify({
                slotid: slot.id, vfib: slot.vfib, first: det.first, last: det.last || '', cell: det.cell, email: det.email || '',
                participants: det.participants || 2, staff, service, sendnotice: notice ? 1 : 0 }), 'application/x-www-form-urlencoded');

            const del = await fetchTor4You('/api/delappt', 'POST', querystring.stringify({ apptid, vfib, sendnotice: 0 }), 'application/x-www-form-urlencoded');
            if (!(del.status == 1 || del.status === "1")) return res.status(400).json({ success: false, error: 'Could not cancel the old appointment (nothing changed): ' + JSON.stringify(del) });

            const slot1 = (await findSlot()) || slot0;
            const next = { first, last: (last !== undefined && last !== '') ? last : original.last, cell, email: (email !== undefined && email !== '') ? email : original.email, participants: Number(participants) || original.participants };
            const added = await book(slot1, next, !!sendnotice);
            if (added.status == 1 || added.status === "1") { await markStamp(stamp).catch(() => {}); return res.status(200).json({ success: true }); }

            // re-creating failed: put the original booking back
            const slot2 = (await findSlot()) || slot1;
            const restored = await book(slot2, original, false);
            const ok = (restored.status == 1 || restored.status === "1");
            return res.status(500).json({ success: false, restored: ok, original, error: 'Update failed: ' + JSON.stringify(added) + (ok ? ' - the original booking was restored' : ' - COULD NOT RESTORE, re-create manually: ' + JSON.stringify(restored)) });
        } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
    });
});

exports.addTor4YouAppointment = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        
        const { slotid, vfib, first, last, cell, email, participants } = req.body;
        const cleanId = (v) => (v && String(v) !== '0') ? String(v) : undefined; // Tor4You returns "0" for 'any service' on slots - not a valid service id for addappt
        const staff = cleanId(req.body.staff); const service = cleanId(req.body.service);
        
        if (!slotid || !vfib || !first || !cell) {
            return res.status(400).json({ error: `Missing required params! received: slotid=${slotid}, vfib=${vfib}, first=${first}, cell=${cell}` });
        }

        try {
            // הוספת שדות staff ו-service מתוך המשתנים שהגדרנו, אם לא הועברו בבקשה
            const formData = querystring.stringify({ 
                slotid, vfib, first, last: last || '', cell, email: email || '',
                participants: participants || 2, 
                staff: staff || DEFAULT_STAFF_ID, 
                service: service || DEFAULT_SERVICE_ID, 
                sendnotice: 1 
            });
            let response = await fetchTor4You('/api/addappt', 'POST', formData, 'application/x-www-form-urlencoded');
            
            if (response.status == 1 || response.status === "1") { await markSeenFromSlot(slotid, vfib).catch(() => {}); return res.status(200).json({ success: true }); }
            else return res.status(400).json({ success: false, error: JSON.stringify(response) });
        } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
    });
});

// ===================== התראות Push =====================
const jlDateTime = () => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return parts.replace(/-/g, ''); // yyyymmdd לפי שעון ישראל
};
const addDaysCompact = (compact, n) => {
    const d = new Date(Date.UTC(+compact.slice(0, 4), +compact.slice(4, 6) - 1, +compact.slice(6, 8) + n));
    return d.toISOString().slice(0, 10).replace(/-/g, '');
};
const apptKey = (a) => `${a.from || ''}_${String(a.cell || a.phone || '').replace(/\D/g, '')}`;

// שולח התראה לכל המכשירים של משתמש (target = 'admin' או מזהה עובד)
const pushTo = async (target, title, body, tab) => {
    const col = gdb().collection('push_tokens');
    const snap = target === 'employees' ? await col.where('role', '==', 'employee').get() : await col.where('employeeId', '==', String(target)).get();
    if (snap.empty) return { sent: 0 };
    const tokens = snap.docs.map(d => d.id);
    const resp = await admin.messaging().sendEachForMulticast({
        tokens,
        data: { title: String(title).slice(0, 100), body: String(body || '').slice(0, 300), tab: String(tab || '') },
        webpush: { headers: { Urgency: 'high' } }
    });
    const dead = [];
    resp.responses.forEach((r, i) => { if (!r.success && r.error && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(r.error.code || '')) dead.push(tokens[i]); });
    await Promise.all(dead.map(t => col.doc(t).delete().catch(() => {})));
    return { sent: resp.successCount, failed: resp.failureCount };
};

exports.sendPush = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { target, title, body, tab } = req.body || {};
        if (!target || !title) return res.status(400).json({ success: false, error: 'Missing target/title' });
        try { const r = await pushTo(target, title, body, tab); return res.status(200).json({ success: true, ...r }); }
        catch (e) { return res.status(500).json({ success: false, error: e.message }); }
    });
});

// מסמן הזמנה שנוצרה מתוך המערכת כ"כבר ידועה" כדי שהמנהל לא יקבל עליה התראה
async function markSeenFromSlot(slotid, vfib) {
    const today = jlDateTime();
    const slots = await fetchTor4You(`/api/slotlist?from=${today}&to=${addDaysCompact(today, 120)}`);
    const sl = (slots.slots || []).find(x => String(x.id) === String(slotid));
    if (!sl) return;
    await markStamp(String(sl.from || '').substring(0, 12));
}
async function markStamp(stamp) {
    if (stamp) await gdb().collection('push_state').doc('seen_stamps').set({ stamps: FieldValue.arrayUnion(stamp) }, { merge: true });
}

// כל 20 דקות (הופחת כדי לא להציף את Tor4You; בהמשך יוחלף ב-Webhook): מחפש הזמנות חדשות ב-Tor4You שלא הוזנו מהמערכת ומתריע למנהל
exports.checkNewBookings = onSchedule({ schedule: 'every 20 minutes', timeZone: 'Asia/Jerusalem', region: 'us-central1' }, async () => {
    // כשה-Webhook של Tor4You מוגדר, הסריקה היא רק גיבוי ורצה פעם בשעה
    try { const g = await gdb().collection('app_settings').doc('global').get(); if (g.exists && g.data().t4yWebhookSecret && new Date().getMinutes() >= 20) return; } catch (e) {}
    const today = jlDateTime();
    const list = await fetchTor4You(`/api/apptlist?from=${today}&to=${addDaysCompact(today, 120)}`);
    if (!(list.status == 1)) return;
    const appts = (list.appts || []).filter(a => a.from && String(a.from).length >= 12);
    const stateRef = gdb().collection('push_state').doc('seen_appts');
    const stampsRef = gdb().collection('push_state').doc('seen_stamps');
    const [st, sst] = await Promise.all([stateRef.get(), stampsRef.get()]);
    const current = appts.map(apptKey);
    if (!st.exists) { await stateRef.set({ keys: current, seeded: new Date().toISOString() }); return; } // ריצה ראשונה: ללא התראות
    const seen = new Set(st.data().keys || []);
    const fromSystem = new Set((sst.exists && sst.data().stamps) || []);
    const fresh = appts.filter(a => !seen.has(apptKey(a)) && !fromSystem.has(String(a.from).substring(0, 12)));
    for (const a of fresh) {
        const f = String(a.from); const date = `${f.slice(6, 8)}/${f.slice(4, 6)}`; const time = `${f.slice(8, 10)}:${f.slice(10, 12)}`;
        const name = `${a.first || ''} ${a.last || ''}`.trim() || 'לקוח';
        await pushTo('admin', 'קבוצה חדשה ביומן', `${date} בשעה ${time} · ${name} · ${Number(a.parts || a.participants || 2)} שחקנים`).catch(() => {});
        // תור להיום או למחר בלי מפעיל: התראה נפרדת וקצרה
        try {
            const dd = `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`;
            if (f.slice(0, 8) === today || f.slice(0, 8) === addDaysCompact(today, 1)) {
                const as = await gdb().collection('assignments').doc(`${dd}_${f.slice(8, 12)}`).get();
                if (!as.exists) await pushTo('admin', `תור ${f.slice(0, 8) === today ? 'להיום' : 'למחר'} ללא מפעיל`, `${time} · ${name} · לחץ לשיוך`, 'calendar').catch(() => {});
            }
        } catch (e) {}
    }
    await stateRef.set({ keys: current, updatedAt: new Date().toISOString() });
    // ניקוי חותמות שעברו
    const old = [...fromSystem].filter(x => x.substring(0, 8) < today);
    if (old.length) await stampsRef.set({ stamps: FieldValue.arrayRemove(...old) }, { merge: true });
});

// כל יום שישי ב-12:00: תזכורת לעובדים לדווח זמינות לשבוע הקרוב
exports.remindAvailability = onSchedule({ schedule: '0 12 * * 5', timeZone: 'Asia/Jerusalem', region: 'us-central1' }, async () => {
    await pushTo('employees', 'תזכורת: דיווח זמינות', 'נא לעדכן זמינות לשבוע הקרוב', 'availability');
});

// ===================== תזכורות ובקרה =====================
const jlDate = (offsetDays = 0) => { const c = addDaysCompact(jlDateTime(), offsetDays); return `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}`; };
const jlNowMin = () => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':'); return (+p[0]) * 60 + (+p[1]); };

// כל בוקר ב-09:00: התראה למנהל על תורים להיום ולמחר שעדיין לא שויכו למפעיל
exports.unassignedReminder = onSchedule({ schedule: '0 9 * * *', timeZone: 'Asia/Jerusalem', region: 'us-central1' }, async () => {
    const today = jlDateTime(); const tomorrow = addDaysCompact(today, 1);
    const list = await fetchTor4You(`/api/apptlist?from=${today}&to=${tomorrow}`);
    if (!(list.status == 1)) return;
    const nowMin = jlNowMin();
    const appts = (list.appts || []).filter(a => a.from && String(a.from).length >= 12).map(a => {
        const f = String(a.from); const ymdStr = `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`;
        return { id: `${ymdStr}_${f.slice(8, 12)}`, isToday: f.slice(0, 8) === today, time: `${f.slice(8, 10)}:${f.slice(10, 12)}`, name: `${a.first || ''} ${a.last || ''}`.trim() || 'לקוח' };
    }).filter(a => !(a.isToday && (+a.time.slice(0, 2)) * 60 + (+a.time.slice(3, 5)) < nowMin));
    if (!appts.length) return;
    const col = gdb().collection('assignments');
    const docs = await gdb().getAll(...appts.map(a => col.doc(a.id)));
    const missing = appts.filter((a, i) => !docs[i].exists);
    if (!missing.length) return;
    const lines = missing.slice(0, 4).map(a => `${a.isToday ? 'היום' : 'מחר'} ${a.time} ${a.name}`).join(', ');
    await pushTo('admin', `${missing.length} תורים ללא מפעיל`, lines + (missing.length > 4 ? ' ועוד' : ''), 'calendar');
});

// שבת 19:00: תזכורת שנייה, רק למי שעדיין לא סימן זמינות לשבוע הקרוב
exports.remindMissingAvailability = onSchedule({ schedule: '0 19 * * 6', timeZone: 'Asia/Jerusalem', region: 'us-central1' }, async () => {
    const sun = jlDate(1); const sat = jlDate(7);
    const cons = await gdb().collection('constraints').where('date', '>=', sun).where('date', '<=', sat).get();
    const have = new Set(); cons.docs.forEach(d => { const x = d.data(); if (x.type === 'available' && x.employeeId) have.add(String(x.employeeId)); });
    const emps = await gdb().collection('employees').get();
    for (const e of emps.docs) { if (!have.has(e.id)) await pushTo(e.id, 'עדיין לא דיווחת זמינות', 'נא לעדכן זמינות לשבוע הקרוב', 'availability').catch(() => {}); }
});

// גיבוי: כל הנתונים החשובים ל-Cloud Storage
const BACKUP_COLLECTIONS = ['employees', 'shifts', 'constraints', 'requests', 'tasks', 'groups', 'expenses', 'issues', 'assignments', 'app_settings'];
async function runBackup() {
    const out = { createdAt: new Date().toISOString(), collections: {} };
    for (const c of BACKUP_COLLECTIONS) {
        const snap = await gdb().collection(c).get();
        out.collections[c] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    const name = `backups/${jlDate()}_${String(jlNowMin()).padStart(4, '0')}.json`;
    await admin.storage().bucket().file(name).save(JSON.stringify(out), { contentType: 'application/json' });
    return { name, counts: Object.fromEntries(Object.entries(out.collections).map(([k, v]) => [k, v.length])) };
}
exports.monthlyBackup = onSchedule({ schedule: '0 3 1 * *', timeZone: 'Asia/Jerusalem', region: 'us-central1', timeoutSeconds: 300, memory: '512MiB' }, async () => { await runBackup(); });
exports.backupNow = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        try { const r = await runBackup(); return res.status(200).json({ success: true, ...r }); }
        catch (e) { return res.status(500).json({ success: false, error: e.message }); }
    });
});

// ===================== חיפוש לקוחות קיימים =====================
let __custCache = { at: 0, list: [] };
const loadCustomers = async () => {
    if (Date.now() - __custCache.at < 5 * 60 * 1000 && __custCache.list.length) return __custCache.list;
    const all = []; let minid = 0;
    for (let page = 0; page < 20; page++) {
        const r = await fetchTor4You(`/api/custlist${minid ? `?minid=${minid}` : ''}`);
        const arr = Array.isArray(r) ? r : (Object.values(r || {}).find(v => Array.isArray(v)) || []);
        if (!arr.length) break;
        arr.forEach(c => all.push({
            id: c.id || c.customerid || '',
            first: String(c.first || c.fname || c.firstname || '').trim(), last: String(c.last || c.lname || c.lastname || '').trim(),
            cell: String(c.cell || c.phone || c.mobile || '').trim(), email: String(c.email || '').trim()
        }));
        const ids = arr.map(c => Number(c.id || c.customerid || 0)).filter(Boolean);
        if (arr.length < 500 || !ids.length) break;
        minid = Math.max(...ids) + 1;
    }
    __custCache = { at: Date.now(), list: all };
    return all;
};
exports.searchTor4YouCustomers = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        const q = String(req.query.q || '').trim().toLowerCase();
        if (q.length < 2) return res.status(200).json({ success: true, customers: [] });
        try {
            const list = await loadCustomers();
            const qd = q.replace(/\D/g, '');
            const words = q.split(/\s+/).filter(Boolean);
            const hits = list.filter(c => {
                const name = `${c.first} ${c.last}`.toLowerCase();
                const phone = c.cell.replace(/\D/g, '');
                if (qd.length >= 3 && phone.includes(qd)) return true;
                return words.every(w => name.includes(w));
            }).slice(0, 8);
            return res.status(200).json({ success: true, customers: hits, total: list.length });
        } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
    });
});

// ===================== סנכרון יומן אוטומטי ברקע (כל שעתיים) =====================
// פותח/סוגר מועדים פנויים ב-Tor4You לפי זמינות העובדים, באותם כללים כמו באפליקציה. לעולם לא נוגע בתורים שהוזמנו.
const AS_STEP = 90, AS_SLOT = 60, AS_PRE = 15;
const AS_ANCHOR = { 0: '12:00', 1: '12:00', 2: '12:00', 3: '12:00', 4: '12:00', 5: '10:00', 6: '20:00' };
const AS_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const AS_DEFAULT_OPENING = { Sunday: { start: '10:00', end: '23:00' }, Monday: { start: '10:00', end: '23:00' }, Tuesday: { start: '10:00', end: '23:00' }, Wednesday: { start: '10:00', end: '23:00' }, Thursday: { start: '10:00', end: '01:00' }, Friday: { start: '09:00', end: '15:00' }, Saturday: { start: '18:00', end: '01:00' } };
const asMin = (t) => { const [h, m] = String(t || '00:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const asTime = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const asDow = (dStr) => { const [y, m, d] = dStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const asAddDays = (dStr, n) => { const [y, m, d] = dStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const asRange = (dow, oh) => { const b = oh && oh[AS_DAYS[dow]]; if (!b || !b.start || !b.end) return null; const o = asMin(b.start); let c = asMin(b.end); if (c <= o) c = 1440; return { open: o, close: Math.min(c, 1440) }; };
const asGrid = (dow, oh) => { const r = asRange(dow, oh); if (!r) return []; let t = asMin(AS_ANCHOR[dow]); while (t - AS_STEP >= r.open) t -= AS_STEP; while (t < r.open) t += AS_STEP; const out = []; for (; t < r.close; t += AS_STEP) out.push(t); return out; };
const asDur = (slot) => { const to = String(slot.slotTo || ''); if (!/^\d{12}$/.test(to)) return AS_SLOT; let d = asMin(`${to.slice(8, 10)}:${to.slice(10, 12)}`) - asMin(slot.time); if (d <= 0) d += 1440; return (d > 0 && d <= 600) ? d : AS_SLOT; };
const asCovered = (rangesByEmp, dStr, startMin, dur) => Object.values(rangesByEmp).some(byDate => (byDate[dStr] || []).some(r => r.s <= startMin - AS_PRE && r.e >= startMin + dur));
async function loadSlotsMapForWeek(fromC, toC) {
    const apptlist = await fetchTor4You(`/api/apptlist?from=${fromC}&to=${toC}&format=2`);
    const slotlist = await fetchTor4You(`/api/slotlist?from=${fromC}&to=${toC}`);
    const bad = [apptlist, slotlist].find(r => r && (r.error || /rate limit/i.test(JSON.stringify(r))));
    if (bad) throw new Error('Tor4You: ' + JSON.stringify(bad).slice(0, 160));
    const map = {};
    const push = (stamp, o) => { const d = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`; (map[d] = map[d] || []).push(o); return d; };
    (apptlist.appts || []).forEach(a => { if (a.from && a.from.length >= 12) push(a.from, { time: `${a.from.slice(8, 10)}:${a.from.slice(10, 12)}`, id: null, vfib: null, isBooked: true, slotTo: a.to || '' }); });
    (slotlist.slots || []).forEach(sl => {
        const time = `${sl.from.slice(8, 10)}:${sl.from.slice(10, 12)}`; const d = `${sl.from.slice(0, 4)}-${sl.from.slice(4, 6)}-${sl.from.slice(6, 8)}`;
        const ex = (map[d] || []).find(x => x.time === time);
        if (ex) { ex.id = sl.id; ex.vfib = sl.vfib; ex.slotTo = sl.to || ex.slotTo; }
        else push(sl.from, { time, id: sl.id, vfib: sl.vfib, isBooked: false, slotTo: sl.to || '' });
    });
    return map;
}
exports.autoSyncCalendar = onSchedule({ schedule: 'every 120 minutes', timeZone: 'Asia/Jerusalem', region: 'us-central1', timeoutSeconds: 300 }, async () => {
    const db = gdb();
    const sdoc = await db.collection('app_settings').doc('global').get();
    const settings = sdoc.exists ? sdoc.data() : {};
    if (settings.autoSyncEnabled === false) return;
    const oh = settings.openingHours || AS_DEFAULT_OPENING;
    const today = jlDate(0); const nowMin = jlNowMin();
    const cons = await db.collection('constraints').where('date', '>=', today).get();
    const rangesByEmp = {};
    cons.docs.forEach(d => { const c = d.data(); if (c.type !== 'available' || !c.employeeId || !c.date || !c.startTime || !c.endTime) return; const s = asMin(c.startTime), e = asMin(c.endTime); if (e <= s) return; ((rangesByEmp[c.employeeId] = rangesByEmp[c.employeeId] || {})[c.date] = (rangesByEmp[c.employeeId][c.date] || [])).push({ s, e }); });
    Object.values(rangesByEmp).forEach(byDate => Object.keys(byDate).forEach(d => { const rs = byDate[d].sort((a, b) => a.s - b.s); const m = []; rs.forEach(r => { const l = m[m.length - 1]; if (l && r.s <= l.e) l.e = Math.max(l.e, r.e); else m.push({ ...r }); }); byDate[d] = m; }));
    const blocks = new Set(); try { (await db.collection('slot_blocks').where('date', '>=', today).get()).docs.forEach(d => blocks.add(d.id)); } catch (e) { console.warn('slot_blocks:', e.message); } // מועדים שנמחקו ידנית ע"י המנהל
    const weekStart0 = asAddDays(today, -asDow(today));
    let totalAdd = 0, totalDel = 0;
    for (let w = 0; w < 3; w++) { // השבוע הנוכחי ושני הבאים
        const ws = asAddDays(weekStart0, w * 7); const we = asAddDays(ws, 6);
        let map; try { map = await loadSlotsMapForWeek(compactDate(ws), compactDate(we)); } catch (e) { console.warn('autoSync stop:', e.message); return; }
        const toAdd = [], toRemove = [];
        for (let i = 0; i < 7; i++) {
            const dStr = asAddDays(ws, i); if (dStr < today) continue;
            const dow = asDow(dStr); const r = asRange(dow, oh); if (!r) continue;
            const existing = map[dStr] || [];
            const occ = existing.map(s => ({ a: asMin(s.time), b: asMin(s.time) + asDur(s) }));
            const GAP = AS_STEP - AS_SLOT;
            const anchored = new Set();
            occ.forEach(o => { for (let t = o.b + GAP; t < r.close; t += AS_STEP) anchored.add(t); for (let t = o.a - AS_STEP; t >= r.open; t -= AS_STEP) anchored.add(t); });
            const order = [...[...anchored].sort((x, y) => x - y), ...asGrid(dow, oh).filter(t => !anchored.has(t))];
            order.forEach(t => {
                if (dStr === today && t <= nowMin) return;
                if (occ.some(o => t < o.b + GAP && o.a < t + AS_SLOT + GAP)) return;
                if (blocks.has(`${dStr}_${asTime(t).replace(':', '')}`)) return;
                if (!asCovered(rangesByEmp, dStr, t, AS_SLOT)) return;
                occ.push({ a: t, b: t + AS_SLOT }); toAdd.push({ date: dStr, time: asTime(t) });
            });
            existing.forEach(s => {
                if (s.isBooked || !s.id || !s.vfib) return;
                if (asCovered(rangesByEmp, dStr, asMin(s.time), asDur(s))) return;
                if (dStr === today && asMin(s.time) <= nowMin) return;
                toRemove.push({ slotid: s.id, vfib: s.vfib });
            });
        }
        if (toAdd.length) {
            const sample = Object.values(map).flat().find(x => x.id) ;
            const probe = await fetchTor4You(`/api/slotlist?from=${compactDate(ws)}&to=${compactDate(asAddDays(ws, 60))}`);
            const found = (probe.status == 1 && probe.slots) ? probe.slots : [];
            const smp = found.find(x => x.maxmembers && Number(x.maxmembers) > 0) || found[0];
            const maxmembers = smp && smp.maxmembers ? smp.maxmembers : 10; const services = smp && smp.services !== undefined ? smp.services : 0;
            for (const sl of toAdd) {
                const formData = querystring.stringify({ staff: DEFAULT_STAFF_ID, from: addMinutesToStamp(sl.date, sl.time, 0), to: addMinutesToStamp(sl.date, sl.time, AS_SLOT), services, maxmembers });
                const resp = await fetchTor4You('/api/addslot', 'POST', formData, 'application/x-www-form-urlencoded');
                if (resp.status == 1 || resp.status === '1') totalAdd++; else if (/rate limit/i.test(JSON.stringify(resp))) { console.warn('autoSync rate limit'); return; }
            }
        }
        for (const sl of toRemove) {
            const resp = await fetchTor4You('/api/delslot', 'POST', `slotid=${encodeURIComponent(sl.slotid)}&vfib=${encodeURIComponent(sl.vfib)}`, 'application/x-www-form-urlencoded');
            if (resp.status == 1 || resp.status === '1') totalDel++; else if (/rate limit/i.test(JSON.stringify(resp))) { console.warn('autoSync rate limit'); return; }
        }
    }
    console.log(`autoSync done: +${totalAdd} -${totalDel}`);
});


// ===================== תזכורות לתורים + התראת תקלה =====================
// כל 10 דקות: תזכורת לעובד המשויך (או למנהל אם התור שויך אליו) 24 שעות ושעתיים לפני התור
exports.appointmentReminders = onSchedule({ schedule: 'every 10 minutes', timeZone: 'Asia/Jerusalem', region: 'us-central1' }, async () => {
    const today = jlDate(0); const nowMin = jlNowMin();
    const [ty, tm, td] = today.split('-').map(Number); const todayUtc = Date.UTC(ty, tm - 1, td);
    const snap = await gdb().collection('assignments').where('date', '>=', today).where('date', '<=', jlDate(2)).get();
    for (const doc of snap.docs) {
        const a = doc.data(); if (!a.employeeId || !a.date || !a.time) continue;
        const [y, m, d] = a.date.split('-').map(Number); const [hh, mm] = String(a.time).split(':').map(Number);
        const until = Math.round((Date.UTC(y, m - 1, d) - todayUtc) / 86400000) * 1440 + hh * 60 + mm - nowMin;
        const who = a.customerName ? ` · ${a.customerName}` : '';
        const dd = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
        const jobs = [];
        if (until <= 1440 && until > 1380) jobs.push({ k: 'h24', title: 'תזכורת: תור מחר', body: `${dd} בשעה ${a.time}${who}` });
        if (until <= 120 && until > 20) jobs.push({ k: 'h2', title: 'תזכורת: תור בעוד שעתיים', body: `היום בשעה ${a.time}${who}` });
        for (const j of jobs) {
            const ref = gdb().collection('reminders_sent').doc(`${doc.id}_${a.employeeId}_${j.k}`);
            if ((await ref.get()).exists) continue;
            await ref.set({ at: new Date().toISOString(), date: a.date });
            await pushTo(String(a.employeeId), j.title, j.body, String(a.employeeId) === 'admin' ? 'calendar' : 'upcoming').catch(() => {});
        }
    }
    // ניקוי תזכורות ישנות
    try { const old = await gdb().collection('reminders_sent').where('date', '<', jlDate(-3)).get(); await Promise.all(old.docs.map(d => d.ref.delete())); } catch (e) {}
});

// כל דקה: התראה למנהל על תקלה חדשה שדיווח עובד
exports.notifyNewIssues = onSchedule({ schedule: 'every 1 minutes', timeZone: 'Asia/Jerusalem', region: 'us-central1' }, async () => {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const snap = await gdb().collection('issues').where('reportedAt', '>=', since).get();
    for (const doc of snap.docs) {
        const x = doc.data(); if (x.adminNotified || !x.reportedBy || x.reportedBy === 'admin') continue;
        await doc.ref.update({ adminNotified: true });
        await pushTo('admin', 'תקלה חדשה', `${x.reportedByName || 'עובד'} · ${x.room || ''}: ${x.description || ''}`, 'issues').catch(() => {});
    }
});


// ===================== Webhook של Tor4You =====================
// הכתובת נרשמת ב-Tor4You: הגדרות / קישוריות / Webhook. הסוד מודבק במסך ההגדרות של המערכת.
const crypto = require("crypto");
exports.tor4youWebhook = functions.https.onRequest(async (req, res) => {
    if (req.method !== 'POST') return res.status(405).send('POST only');
    try {
        const g = await gdb().collection('app_settings').doc('global').get();
        const secret = g.exists ? g.data().t4yWebhookSecret : '';
        if (!secret) { console.warn('tor4youWebhook: no secret configured'); return res.status(401).send('secret not configured'); }
        const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
        const ts = req.get('X-Webhook-Timestamp') || ''; const sig = (req.get('X-Webhook-Signature') || '').replace(/^sha256=/, '');
        const calc = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`, 'utf8').digest('hex');
        const okSig = sig.length === calc.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(calc));
        if (!okSig || Math.abs(Date.now() / 1000 - Number(ts)) > 600) return res.status(401).send('bad signature');
        const b = req.body || {};
        if (b.hooktype !== 'appointments') return res.status(200).send('ignored');
        if (String(b.id) !== '0') { try { await gdb().collection('webhook_seen').doc(`appt_${b.id}`).create({ at: new Date().toISOString() }); } catch (e) { return res.status(200).send('duplicate'); } }
        if (String(b.action) === '1' && String(b.apptstatus) === '1' && b.ISOFrom_date) {
            const iso = String(b.ISOFrom_date); // 2026-11-05 19:30:00
            const dd = iso.slice(0, 10); const time = iso.slice(11, 16); const stamp = iso.replace(/\D/g, '').slice(0, 12);
            await new Promise(r => setTimeout(r, 6000)); // נותן למערכת זמן לסמן הזמנה שנוצרה ממנה
            const sst = await gdb().collection('push_state').doc('seen_stamps').get();
            const fromSystem = new Set((sst.exists && sst.data().stamps) || []);
            if (!fromSystem.has(stamp)) {
                const name = `${b.customerfirst || ''} ${b.customerlast || ''}`.trim() || 'לקוח';
                await markStamp(stamp); // שהסריקה הגיבוי לא תתריע שוב
                await pushTo('admin', 'קבוצה חדשה ביומן', `${dd.slice(8, 10)}/${dd.slice(5, 7)} בשעה ${time} · ${name} · ${Number(b.participants || 2)} שחקנים`).catch(() => {});
                if (dd === jlDate(0) || dd === jlDate(1)) {
                    const as = await gdb().collection('assignments').doc(`${dd}_${time.replace(':', '')}`).get();
                    if (!as.exists) await pushTo('admin', `תור ${dd === jlDate(0) ? 'להיום' : 'למחר'} ללא מפעיל`, `${time} · ${name} · לחץ לשיוך`, 'calendar').catch(() => {});
                }
            }
        }
        return res.status(200).send('ok');
    } catch (e) { console.error('tor4youWebhook', e); return res.status(500).send('error'); }
});


// ===================== כניסה מאובטחת (בדיקת קוד בשרת) =====================
// הקודים לא נשלחים לדפדפן. השרת בודק ומחזיר אסימון כניסה עם תפקיד (admin / employee).
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// פרטים ציבוריים למסך הכניסה: שמות עובדים (בלי קודים ובלי פרטים אישיים) ועיצוב בסיסי
exports.loginInfo = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            const db = gdb();
            const [emps, g, sec] = await Promise.all([db.collection('employees').get(), db.collection('app_settings').doc('global').get(), db.collection('admin_secrets').doc('main').get()]);
            const gd = g.exists ? g.data() : {};
            return res.status(200).json({
                employees: emps.docs.map(d => ({ id: d.id, name: d.data().name || '' })),
                businessName: gd.businessName || '', primaryColor: gd.primaryColor || '', secondaryColor: gd.secondaryColor || '',
                secure: !!(sec.exists && sec.data().secureMode)
            });
        } catch (e) { return res.status(500).json({ error: e.message }); }
    });
});

const LOGIN_SA = 'firebase-adminsdk-fbsvc@g-room-escape-room-management.iam.gserviceaccount.com'; // חשבון עם הרשאת חתימה על אסימוני כניסה
exports.loginServer = functions.runWith({ serviceAccount: LOGIN_SA }).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        try {
            const { empId, code } = req.body || {};
            if (!empId || !code) return res.status(400).json({ error: 'missing' });
            const db = gdb(); const id = String(empId);
            const attRef = db.collection('login_attempts').doc(id);
            const att = await attRef.get(); const ad = att.exists ? att.data() : {};
            if (ad.lockedUntil && ad.lockedUntil > Date.now()) return res.status(429).json({ error: 'locked', minutes: Math.ceil((ad.lockedUntil - Date.now()) / 60000) });
            let ok = false, name = '';
            if (id === 'admin') {
                const [sec, g] = await Promise.all([db.collection('admin_secrets').doc('main').get(), db.collection('app_settings').doc('global').get()]);
                const expected = (sec.exists && sec.data().adminCode) || (g.exists && g.data().adminCode) || 'admin123';
                ok = safeEq(code, expected); name = 'מנהל המערכת';
            } else {
                const e = await db.collection('employees').doc(id).get();
                if (e.exists) {
                    const c = await db.collection('employee_codes').doc(id).get();
                    const expected = (c.exists && c.data().code) || e.data().code;
                    ok = expected !== undefined && expected !== null && String(expected) !== '' && safeEq(code, expected); name = e.data().name || '';
                }
            }
            if (!ok) {
                const fails = (ad.fails || 0) + 1;
                await attRef.set({ fails: fails >= 8 ? 0 : fails, lockedUntil: fails >= 8 ? Date.now() + 10 * 60000 : 0, last: new Date().toISOString() });
                return res.status(401).json({ error: 'wrong' });
            }
            if (ad.fails || ad.lockedUntil) await attRef.set({ fails: 0, lockedUntil: 0 });
            const role = id === 'admin' ? 'admin' : 'employee';
            let token = null, tokenError = null;
            try { token = await admin.auth().createCustomToken(id === 'admin' ? 'admin' : `emp_${id}`, { role, empId: id }); }
            catch (e) { tokenError = e.message; console.error('createCustomToken failed:', e.message); }
            return res.status(200).json({ ok: true, role, empId: id, name, token, tokenError });
        } catch (e) { console.error('loginServer', e); return res.status(500).json({ error: e.message }); }
    });
});

// בדיקת תקינות: האם השרת מסוגל להנפיק אסימוני כניסה (לא חושף מידע)
exports.loginSelfTest = functions.runWith({ serviceAccount: LOGIN_SA }).https.onRequest((req, res) => {
    cors(req, res, async () => {
        try { await admin.auth().createCustomToken('selftest', { role: 'none' }); return res.status(200).json({ ok: true }); }
        catch (e) { return res.status(200).json({ ok: false, error: e.message }); }
    });
});
