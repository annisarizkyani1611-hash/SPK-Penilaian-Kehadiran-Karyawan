require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: '/tmp' }); 

// KONFIGURASI DATABASE
const dbOptions = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'spk_saw_final',
    port: process.env.DB_PORT || 3306,
    ssl: false // Wajib false untuk hosting cPanel
};

const sessionStore = new MySQLStore(dbOptions);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
    key: 'session_cookie_pam', // Ganti nama cookie biar unik
    secret: 'pam_tirta_group_secret_key',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

const pool = mysql.createPool(dbOptions);

async function getDB() { return await pool.getConnection(); }
app.use(async (req, res, next) => { req.dbPool = pool; next(); });

// Helper Query
const query = async (sql, params = []) => {
    const conn = await getDB();
    try { const [results] = await conn.execute(sql, params); return results; } finally { conn.release(); }
};

// Routes
app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('index', { page: 'login', error: null });
});

app.post('/login', async (req, res) => {
    try {
        const rows = await query("SELECT * FROM users WHERE username=?", [req.body.username]);
        if (rows.length > 0 && rows[0].password === req.body.password) {
            req.session.user = rows[0];
            req.session.save(() => res.redirect('/dashboard'));
        } else {
            res.render('index', { page: 'login', error: 'Username atau Password Salah' });
        }
    } catch(e) { res.render('index', { page: 'login', error: 'DB Error: ' + e.message }); }
});

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });
const auth = (req, res, next) => { if (!req.session.user) return res.redirect('/'); next(); };

app.get('/dashboard', auth, async (req, res) => {
    try {
        const k = await query("SELECT count(*) as c FROM karyawan");
        const c = await query("SELECT count(*) as c FROM kriteria");
        res.render('index', { page: 'dashboard', user: req.session.user, c_k: k[0].c, c_c: c[0].c });
    } catch (e) { res.send("Error: " + e.message); }
});

app.get('/kriteria', auth, async (req, res) => {
    const rows = await query("SELECT * FROM kriteria ORDER BY kode ASC");
    res.render('index', { page: 'kriteria', user: req.session.user, kriteria: rows });
});
app.post('/save_kriteria', auth, async (req, res) => {
    const { id, kode, nama, atribut, bobot } = req.body;
    if(!id) await query("INSERT INTO kriteria (kode,nama,atribut,bobot) VALUES (?,?,?,?)", [kode,nama,atribut,bobot]);
    else await query("UPDATE kriteria SET kode=?, nama=?, atribut=?, bobot=? WHERE id=?", [kode,nama,atribut,bobot,id]);
    res.redirect('/kriteria');
});
app.use('/del_kriteria', auth, async (req, res) => {
    let ids = req.query.id ? [req.query.id] : (req.body.ids || []); if(!Array.isArray(ids)) ids=[ids];
    if(ids.length>0) { const p=ids.map(()=>'?').join(','); await query(`DELETE FROM kriteria WHERE id IN (${p})`, ids); await query(`DELETE FROM nilai WHERE id_kriteria IN (${p})`, ids); }
    res.redirect('/kriteria');
});

app.get('/karyawan', auth, async (req, res) => {
    const krit = await query("SELECT * FROM kriteria ORDER BY kode ASC");
    const kars = await query("SELECT * FROM karyawan ORDER BY id DESC");
    for(let k of kars) { k.vals = {}; const vs = await query("SELECT id_kriteria, nilai FROM nilai WHERE id_karyawan=?", [k.id]); vs.forEach(v => k.vals[v.id_kriteria] = v.nilai); }
    res.render('index', { page: 'karyawan', user: req.session.user, kriteria: krit, karyawan: kars });
});
app.post('/save_karyawan', auth, async (req, res) => {
    const { id, nama, jabatan, nilai } = req.body; let kid = id;
    if(!id) { const ret = await query("INSERT INTO karyawan (nama,jabatan) VALUES (?,?)", [nama,jabatan]); kid = ret.insertId; } 
    else { await query("UPDATE karyawan SET nama=?, jabatan=? WHERE id=?", [nama,jabatan,id]); }
    if(nilai) for(let [cid, val] of Object.entries(nilai)) {
        const ex = await query("SELECT * FROM nilai WHERE id_karyawan=? AND id_kriteria=?", [kid, cid]);
        if(ex.length) await query("UPDATE nilai SET nilai=? WHERE id_karyawan=? AND id_kriteria=?", [val, kid, cid]); else await query("INSERT INTO nilai VALUES (?,?,?)", [kid, cid, val]);
    }
    res.redirect('/karyawan');
});
app.use('/del_karyawan', auth, async (req, res) => {
    let ids = req.query.id ? [req.query.id] : (req.body.ids || []); if(!Array.isArray(ids)) ids=[ids];
    if(ids.length>0) { const p=ids.map(()=>'?').join(','); await query(`DELETE FROM karyawan WHERE id IN (${p})`, ids); await query(`DELETE FROM nilai WHERE id_karyawan IN (${p})`, ids); }
    res.redirect('/karyawan');
});

app.post('/import_csv', auth, upload.single('file_csv'), async (req, res) => {
    if(req.file) { try { const lines=fs.readFileSync(req.file.path,'utf-8').split('\n'); const krit=await query("SELECT id FROM kriteria ORDER BY kode ASC");
            for(let i=1;i<lines.length;i++){ const c=lines[i].trim().split(','); if(c.length<2) continue;
                const r=await query("INSERT INTO karyawan (nama,jabatan) VALUES (?,?)",[c[0],c[1]]);
                for(let j=0;j<krit.length;j++) if(c[j+2]) await query("INSERT INTO nilai VALUES (?,?,?)",[r.insertId,krit[j].id,c[j+2]]);
            } } catch(e){} } res.redirect('/karyawan');
});
app.get('/export_csv', auth, async (req, res) => {
    const krit=await query("SELECT kode,nama FROM kriteria ORDER BY kode ASC"); const kars=await query("SELECT * FROM karyawan");
    let csv="Nama,Jabatan,"+krit.map(k=>k.kode+'-'+k.nama).join(',')+"\n";
    for(let k of kars) { let l=[k.nama,k.jabatan]; for(let c of krit) { const v=await query("SELECT nilai FROM nilai n JOIN kriteria k ON n.id_kriteria=k.id WHERE id_karyawan=? AND k.kode=?",[k.id,c.kode]); l.push(v.length?v[0].nilai:0); } csv+=l.join(',')+"\n"; }
    res.header('Content-Type','text/csv'); res.attachment('Data_Pegawai_PAMTirta.csv'); res.send(csv);
});

app.all('/analisis', auth, async (req, res) => {
    const kriteria = await query("SELECT * FROM kriteria ORDER BY kode ASC");
    const karyawan = await query("SELECT * FROM karyawan");
    let bobot = {}; kriteria.forEach(k => bobot[k.id] = k.bobot); // Hapus fitur ubah bobot dinamis agar simpel
    let matriks = {}, minmax = {};
    for(let k of karyawan) { matriks[k.id] = {}; for(let c of kriteria) { const row = await query("SELECT nilai FROM nilai WHERE id_karyawan=? AND id_kriteria=?", [k.id, c.id]); let val = row.length ? row[0].nilai : 0; matriks[k.id][c.id] = val; if(!minmax[c.id]) minmax[c.id] = { min: val, max: val }; else { minmax[c.id].min = Math.min(minmax[c.id].min, val); minmax[c.id].max = Math.max(minmax[c.id].max, val); } } }
    let hasil = [];
    for(let k of karyawan) { let total = 0; let details = {}; for(let c of kriteria) { let id = c.id; let val = matriks[k.id][id]; let r = 0; if(c.atribut === 'benefit') r = (minmax[id].max > 0) ? val / minmax[id].max : 0; else r = (val > 0) ? minmax[id].min / val : 1; total += r * bobot[id]; details[c.kode] = val; } hasil.push({ nama: k.nama, jabatan: k.jabatan, nilai: total, detail: details }); }
    hasil.sort((a, b) => b.nilai - a.nilai);
    res.render('index', { page: 'analisis', user: req.session.user, kriteria, hasil, bobot_active: bobot });
});

module.exports = app;
if (require.main === module) app.listen(3000, () => console.log('PAM Tirta App running...'));
