import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ──────────────────────────────────────────────────────────────
//  🔧 CONFIGURACIÓN — reemplaza con tus credenciales de Supabase
//  Supabase Dashboard → Settings → API
// ──────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://qpoxhiermauupmlymsvo.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFwb3hoaWVybWF1dXBtbHltc3ZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NjQyMTksImV4cCI6MjA4NzQ0MDIxOX0.4uhNToxuckdYeLuRdcBlpmA_Fc5eYW09dgDgLv7FaN4";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Convierte "2026-01-29" → "29/01/2026"
const fmtDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

// ──────────────────────────────────────────────────────────────
//  DATA LAYER — todas las operaciones con Supabase
// ──────────────────────────────────────────────────────────────

/** Carga todas las reservas con sus pistas y jugadores */
async function fetchReservations() {
  const { data: reservations, error: rErr } = await sb
    .from("reservations")
    .select("*")
    .order("date", { ascending: true });
  if (rErr) throw rErr;

  const { data: courts, error: cErr } = await sb
    .from("courts")
    .select("*")
    .order("sort_order");
  if (cErr) throw cErr;

  const { data: players, error: pErr } = await sb
    .from("players")
    .select("*")
    .order("sort_order");
  if (pErr) throw pErr;

  // Montar estructura anidada igual a la versión local
  return reservations.map(r => {
    const rCourts = courts
      .filter(c => c.reservation_id === r.id)
      .map(c => ({
        id: c.id,
        name: c.name,
        price: parseFloat(c.price),
        payTo: c.pay_to,
        players: players
          .filter(p => p.court_id === c.id)
          .map(p => p.name),
      }));

    const poolPlayers = players
      .filter(p => p.reservation_id === r.id && p.status === "inscrito" && !p.court_id)
      .map(p => p.name);

    const waitlistPlayers = players
      .filter(p => p.reservation_id === r.id && p.status === "espera")
      .map(p => p.name);

    return {
      id: r.id,
      venue: r.venue,
      date: r.date,
      timeStart: r.time_start.slice(0, 5),
      timeEnd: r.time_end.slice(0, 5),
      courts: rCourts,
      pool: poolPlayers,
      waitlist: waitlistPlayers,
      createdAt: r.created_at,
    };
  });
}

/** Crea una reserva completa (reserva + pistas) */
async function createReservation(form) {
  const { data: res, error: rErr } = await sb
    .from("reservations")
    .insert({
      venue: form.venue,
      date: form.date,
      time_start: form.timeStart,
      time_end: form.timeEnd,
    })
    .select()
    .single();
  if (rErr) throw rErr;

  const numCourts = parseInt(form.numCourts);
  const price = parseFloat(form.price) || 6;
  const baseName = (form.firstCourt || "Pista 1").trim();
  const matchName = baseName.match(/^(.*?)(\d+)$/);

  const courtsToInsert = Array.from({ length: numCourts }, (_, i) => {
    const name = matchName
      ? matchName[1] + (parseInt(matchName[2]) + i)
      : (i === 0 ? baseName : baseName + " " + (i + 1));
    return { reservation_id: res.id, name, price, pay_to: "", sort_order: i };
  });

  const { error: cErr } = await sb.from("courts").insert(courtsToInsert);
  if (cErr) throw cErr;

  return res.id;
}

/** Actualiza campos de la reserva */
async function updateReservation(resId, fields) {
  const mapped = {};
  if (fields.venue !== undefined)     mapped.venue      = fields.venue;
  if (fields.date !== undefined)      mapped.date       = fields.date;
  if (fields.timeStart !== undefined) mapped.time_start = fields.timeStart;
  if (fields.timeEnd !== undefined)   mapped.time_end   = fields.timeEnd;

  const { error } = await sb.from("reservations").update(mapped).eq("id", resId);
  if (error) throw error;
}

/** Elimina una reserva (cascade elimina pistas y jugadores) */
async function deleteReservationsBefore(date) {
  // date is ISO string "YYYY-MM-DD"
  const { data, error: fetchErr } = await sb
    .from("reservations")
    .select("id")
    .lt("date", date);
  if (fetchErr) throw fetchErr;
  for (const r of data) {
    await sb.from("reservations").delete().eq("id", r.id);
  }
  return data.length;
}

async function deleteReservation(resId) {
  const { error } = await sb.from("reservations").delete().eq("id", resId);
  if (error) throw error;
}

/** Añade una pista a una reserva */
async function addCourt(resId, name, price) {
  const { data, error } = await sb
    .from("courts")
    .insert({ reservation_id: resId, name, price, pay_to: "" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Elimina una pista (solo si no tiene jugadores) */
async function deleteCourt(courtId) {
  const { error } = await sb.from("courts").delete().eq("id", courtId);
  if (error) throw error;
}

/** Actualiza precio o pay_to de una pista */
async function updateCourt(courtId, fields) {
  const mapped = {};
  if (fields.name  !== undefined) mapped.name    = fields.name;
  if (fields.price !== undefined) mapped.price   = fields.price;
  if (fields.payTo !== undefined) mapped.pay_to  = fields.payTo;
  const { error } = await sb.from("courts").update(mapped).eq("id", courtId);
  if (error) throw error;
}

/** Inscribe un jugador (inscrito o espera) */
async function addPlayer(resId, name, status = "inscrito") {
  const { data, error } = await sb
    .from("players")
    .insert({ reservation_id: resId, name, status, court_id: null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Elimina un jugador */
async function deletePlayer(resId, name) {
  const { error } = await sb
    .from("players")
    .delete()
    .eq("reservation_id", resId)
    .eq("name", name);
  if (error) throw error;
}

/** Mueve un jugador: cambia court_id y/o status */
async function movePlayer(resId, name, target, courts) {
  let courtId = null;
  let status = "inscrito";

  if (target === "waitlist") {
    status = "espera";
    courtId = null;
  } else if (target === "pool") {
    status = "inscrito";
    courtId = null;
  } else {
    // target es un court id
    status = "inscrito";
    courtId = target;
  }

  const { error } = await sb
    .from("players")
    .update({ court_id: courtId, status })
    .eq("reservation_id", resId)
    .eq("name", name);
  if (error) throw error;
}

/** Aplica edición de una reserva (campos base + añadir/quitar pistas) */
async function applyReservationEdit(existing, form) {
  await updateReservation(existing.id, {
    venue: form.venue,
    date: form.date,
    timeStart: form.timeStart,
    timeEnd: form.timeEnd,
  });

  const newCount = parseInt(form.numCourts);
  const currentCourts = existing.courts;

  if (newCount > currentCourts.length) {
    const last = currentCourts[currentCourts.length - 1];
    const m = last ? last.name.match(/^(.*?)(\d+)$/) : null;
    for (let i = 0; i < newCount - currentCourts.length; i++) {
      const newName = m
        ? m[1] + (parseInt(m[2]) + i + 1)
        : (last ? last.name + " " + (currentCourts.length + i + 1) : "Pista " + (currentCourts.length + i + 1));
      await addCourt(existing.id, newName, parseFloat(form.price) || 6);
    }
  } else if (newCount < currentCourts.length) {
    const toRemove = currentCourts.slice(newCount);
    for (const c of toRemove) {
      await deleteCourt(c.id);
    }
  }
}

// ──────────────────────────────────────────────────────────────
//  STYLES
// ──────────────────────────────────────────────────────────────
const css = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=Inter:wght@400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
:root{
  --bg:#0c0e14;--s1:#13161f;--s2:#1a1e2c;--s3:#222840;
  --border:#2c3150;--accent:#22d68a;--danger:#ff5252;--info:#5b9fff;
  --text:#edf0f8;--sub:#8b91ad;
  --ff:'Inter',sans-serif;--fd:'Syne',sans-serif;
  --r:14px;
}
html{font-size:16px;background:var(--bg);}
body{font-family:var(--ff);color:var(--text);background:var(--bg);min-height:100vh;overscroll-behavior:none;}
h1,h2,h3,h4{font-family:var(--fd);}
input,select,textarea,button{font-family:var(--ff);}

.app{max-width:480px;margin:0 auto;padding:0 0 100px;}
.topbar{position:sticky;top:0;z-index:50;background:var(--bg);border-bottom:1px solid var(--border);padding:12px 16px;display:flex;align-items:center;gap:10px;}
.topbar-logo{width:36px;height:36px;background:var(--accent);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}
.topbar h1{font-size:20px;color:var(--accent);line-height:1;}
.topbar p{font-size:11px;color:var(--sub);}
.content{padding:16px;}

.botnav{position:fixed;bottom:0;left:0;right:0;z-index:50;background:var(--s1);border-top:1px solid var(--border);display:flex;max-width:480px;margin:0 auto;}
.botnav-btn{flex:1;display:flex;flex-direction:column;align-items:center;padding:10px 4px 14px;border:none;background:none;color:var(--sub);font-size:10px;font-weight:600;gap:3px;cursor:pointer;transition:color .15s;}
.botnav-btn .icon{font-size:20px;}
.botnav-btn.active{color:var(--accent);}

.card{background:var(--s1);border:1px solid var(--border);border-radius:var(--r);padding:16px;margin-bottom:12px;}
.card-title{font-size:18px;color:var(--text);font-family:var(--fd);}
.card-sub{font-size:12px;color:var(--sub);margin-top:3px;line-height:1.6;}

.badge{display:inline-flex;align-items:center;gap:3px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700;}
.b-green{background:#22d68a18;color:var(--accent);border:1px solid #22d68a30;}
.b-red{background:#ff525218;color:var(--danger);border:1px solid #ff525230;}
.b-blue{background:#5b9fff18;color:var(--info);border:1px solid #5b9fff30;}

.prog{height:5px;background:var(--s3);border-radius:3px;overflow:hidden;margin-top:10px;}
.prog-fill{height:100%;background:var(--accent);border-radius:3px;transition:width .4s;}
.prog-fill.full{background:var(--danger);}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:10px 16px;border-radius:10px;border:none;cursor:pointer;font-size:14px;font-weight:600;transition:all .15s;-webkit-appearance:none;}
.btn-p{background:var(--accent);color:#080a10;}
.btn-p:active{filter:brightness(.9);}
.btn-d{background:#ff525218;color:var(--danger);border:1px solid #ff525230;}
.btn-ghost{background:var(--s3);color:var(--text);}
.btn-sm{padding:8px 12px;font-size:12px;border-radius:8px;}
.btn-xs{padding:5px 8px;font-size:11px;border-radius:6px;}
.btn-block{width:100%;}
.btn:disabled{opacity:.35;cursor:not-allowed;}
.btn:active{transform:scale(.97);}

.field{margin-bottom:12px;}
.field label{display:block;font-size:11px;color:var(--sub);font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;}
.field input,.field select{width:100%;background:var(--s2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;color:var(--text);font-size:16px;outline:none;-webkit-appearance:none;}
.field input:focus,.field select:focus{border-color:var(--accent);}
.field input::placeholder{color:var(--sub);}
.fg2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.fg3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;}

.sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.sh-title{font-size:15px;color:var(--sub);font-family:var(--fd);}

.chip{display:flex;align-items:center;justify-content:space-between;padding:11px 12px;background:var(--s2);border:1px solid var(--border);border-radius:10px;font-size:14px;margin-bottom:6px;}
.chip-name{display:flex;align-items:center;gap:8px;}
.chip-del{background:none;border:none;color:var(--sub);font-size:18px;line-height:1;cursor:pointer;padding:4px 6px;border-radius:6px;min-width:32px;min-height:32px;display:flex;align-items:center;justify-content:center;}
.chip-del:active{background:var(--s3);color:var(--danger);}
.chip-reserve{opacity:.65;border-style:dashed;}
.chip-movebtn{background:var(--s3);border:none;color:var(--accent);border-radius:7px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;min-height:32px;}
.chip-movebtn:active{filter:brightness(.85);}

.court-box{background:var(--s2);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:10px;}
.court-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.court-name{font-family:var(--fd);font-size:16px;color:var(--info);}
.court-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;}
.court-fields label{font-size:10px;color:var(--sub);font-weight:600;text-transform:uppercase;letter-spacing:.4px;display:block;margin-bottom:3px;}
.court-fields input{width:100%;background:var(--s1);border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--text);font-size:15px;outline:none;}
.court-fields input:focus{border-color:var(--accent);}
.court-slot{min-height:48px;border:1.5px dashed var(--border);border-radius:8px;padding:6px;background:var(--s1);}
.court-slot.empty-hl{border-color:#22d68a40;}

.pool-box{background:var(--s2);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:12px;}

.wa-box{background:#071a0f;border:1px solid #22d68a25;border-radius:12px;padding:14px;font-family:monospace;font-size:13px;color:#22d68a;white-space:pre-wrap;word-break:break-word;line-height:1.6;max-height:50vh;overflow-y:auto;}

.overlay{position:fixed;inset:0;background:#000000b0;z-index:100;display:flex;align-items:flex-end;}
.sheet{background:var(--s1);border-radius:20px 20px 0 0;padding:20px;width:100%;max-height:90vh;overflow-y:auto;border:1px solid var(--border);border-bottom:none;}
.sheet-handle{width:40px;height:4px;background:var(--border);border-radius:2px;margin:0 auto 16px;}
.sheet h2{font-size:22px;color:var(--accent);margin-bottom:14px;}

.toast{position:fixed;top:68px;left:50%;transform:translateX(-50%);background:var(--s3);color:var(--text);padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:200;white-space:nowrap;border:1px solid var(--border);box-shadow:0 4px 20px #00000060;animation:tin .2s ease;}
@keyframes tin{from{opacity:0;top:58px}to{opacity:1;top:68px}}

.move-list{list-style:none;margin-top:6px;}
.move-item{padding:14px;border-radius:10px;border:1px solid var(--border);margin-bottom:8px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;background:var(--s2);font-size:14px;}
.move-item:active{background:var(--s3);}
.move-item.dis{opacity:.35;cursor:not-allowed;}

.seg{display:flex;background:var(--s2);border-radius:10px;padding:3px;gap:2px;margin-bottom:12px;}
.seg-btn{flex:1;padding:9px;border:none;background:none;color:var(--sub);font-size:13px;font-weight:600;border-radius:8px;cursor:pointer;transition:all .15s;}
.seg-btn.active{background:var(--s3);color:var(--text);}

.fab{position:fixed;bottom:72px;right:16px;z-index:40;width:54px;height:54px;background:var(--accent);border:none;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:28px;cursor:pointer;box-shadow:0 4px 24px #22d68a50;color:#080a10;font-weight:700;}
.fab:active{transform:scale(.93);}

hr{border:none;border-top:1px solid var(--border);margin:12px 0;}
.empty{color:var(--sub);font-size:14px;text-align:center;padding:40px 16px;line-height:1.6;}
.row{display:flex;gap:8px;align-items:center;}
.spacer{flex:1;}
.warn-box{background:#ff525210;border:1px solid #ff525230;border-radius:10px;padding:10px 12px;font-size:13px;color:var(--danger);margin-bottom:12px;}
.info-box{background:#22d68a0a;border:1px solid #22d68a20;border-radius:10px;padding:10px 12px;font-size:13px;color:var(--sub);margin-bottom:12px;}

.spinner{display:inline-block;width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-full{display:flex;align-items:center;justify-content:center;gap:10px;padding:60px 16px;color:var(--sub);font-size:14px;}

.db-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;background:#22d68a10;border:1px solid #22d68a20;border-radius:20px;font-size:10px;color:var(--accent);font-weight:700;margin-left:8px;}
`;

// ──────────────────────────────────────────────────────────────
//  APP ROOT
// ──────────────────────────────────────────────────────────────
export default function App() {
  const [reservations, setReservations] = useState([]);
  const [tab, setTab] = useState("home");
  const [activeId, setActiveId] = useState(null);
  const [toast, setToast] = useState(null);
  const [modal, setModal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await fetchReservations();
      setReservations(data);
    } catch (e) {
      showToast("❌ Error al cargar datos");
      console.error(e);
    }
  }, []);

  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, [reload]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  }, []);

  const withSave = useCallback(async (fn, successMsg) => {
    setSaving(true);
    try {
      await fn();
      await reload();
      if (successMsg) showToast(successMsg);
    } catch (e) {
      console.error(e);
      showToast("❌ " + (e.message || "Error al guardar"));
    } finally {
      setSaving(false);
    }
  }, [reload, showToast]);

  const liveRes = reservations.find(r => r.id === activeId);
  const today = new Date().toISOString().split("T")[0];
  const upcoming = reservations.filter(r => r.date >= today).sort((a,b)=>a.date.localeCompare(b.date));
  const past = reservations.filter(r => r.date < today).sort((a,b)=>b.date.localeCompare(a.date));

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <div className="topbar">
          <div className="topbar-logo">🎾</div>
          <div>
            <h1>Pádel Manager <span className="db-badge">☁️ Supabase</span></h1>
            <p>Reservas y partidos</p>
          </div>
          {saving && <div style={{marginLeft:"auto"}}><div className="spinner"/></div>}
        </div>

        <div className="content">
          {tab === "home" && (
            <HomeTab
              upcoming={upcoming} past={past} loading={loading}
              onOpen={(id) => { setActiveId(id); setTab("manage"); }}
              onDelete={(id) => withSave(() => deleteReservation(id), "Reserva cancelada")}
              onEdit={(res) => setModal({type:"res", res})}
              onPurgeBefore={async (date, count) => {
                if (window.confirm(`¿Eliminar ${count} reserva${count>1?"s":""} anteriores al ${fmtDate(date)}?`)) {
                  withSave(() => deleteReservationsBefore(date), `${count} reserva${count>1?"s":""} eliminada${count>1?"s":""} ✓`);
                }
              }}
            />
          )}
          {tab === "manage" && liveRes && (
            <ManageTab
              res={liveRes}
              withSave={withSave}
              showToast={showToast}
              setModal={(m) => setModal({...m, resId: liveRes.id})}
            />
          )}
        </div>

        {tab === "home" && (
          <button className="fab" onClick={() => setModal({type:"res"})}>+</button>
        )}

        <nav className="botnav">
          <button className={`botnav-btn ${tab==="home"?"active":""}`} onClick={()=>setTab("home")}>
            <span className="icon">🏠</span>Reservas
          </button>
          {liveRes && (
            <button className={`botnav-btn ${tab==="manage"?"active":""}`} onClick={()=>setTab("manage")}>
              <span className="icon">📋</span>Gestionar
            </button>
          )}
        </nav>
      </div>

      {/* Modals */}
      {modal?.type === "res" && (
        <ResModal
          existing={modal.res}
          onClose={() => setModal(null)}
          onSave={(form) => {
            const fn = modal.res
              ? () => applyReservationEdit(modal.res, form)
              : () => createReservation(form);
            withSave(fn, modal.res ? "Reserva actualizada ✓" : "Reserva creada ✓");
            setModal(null);
          }}
        />
      )}

      {modal?.type === "move" && liveRes && (
        <MoveModal
          player={modal.player}
          source={modal.source}
          res={liveRes}
          onMove={(target) => {
            const label = target === "pool" ? "Disponibles"
              : target === "waitlist" ? "Lista de espera"
              : liveRes.courts.find(c=>c.id===target)?.name || target;
            withSave(
              () => movePlayer(liveRes.id, modal.player, target, liveRes.courts),
              `${modal.player} → ${label}`
            );
            setModal(null);
          }}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.type === "wa" && liveRes && (
        <WAModal res={liveRes} onClose={() => setModal(null)} showToast={showToast} />
      )}

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

// ──────────────────────────────────────────────────────────────
//  HOME TAB
// ──────────────────────────────────────────────────────────────
function HomeTab({ upcoming, past, loading, onOpen, onDelete, onEdit, onPurgeBefore }) {
  const [purgeDate, setPurgeDate] = useState("");
  if (loading) return (
    <div className="loading-full">
      <div className="spinner"/> Conectando con Supabase…
    </div>
  );
  if (!upcoming.length && !past.length)
    return <p className="empty">No hay reservas.<br/>Pulsa <strong style={{color:"var(--accent)"}}>+</strong> para crear una.</p>;

  const purgeCount = purgeDate ? past.filter(r => r.date < purgeDate).length : 0;

  return (
    <>
      {upcoming.length > 0 && <>
        <div className="sh"><span className="sh-title">Próximas</span></div>
        {upcoming.map(r=><ResCard key={r.id} res={r} onOpen={onOpen} onDelete={onDelete} onEdit={onEdit}/>)}
      </>}
      {past.length > 0 && <>
        <div className="sh" style={{marginTop:8}}><span className="sh-title">Historial</span></div>
        {past.map(r=><ResCard key={r.id} res={r} onOpen={onOpen} onDelete={onDelete} onEdit={onEdit}/>)}
        <div style={{background:"var(--s2)",border:"1px solid var(--border)",borderRadius:12,padding:14,marginTop:8}}>
          <div style={{fontSize:13,color:"var(--sub)",marginBottom:10,fontWeight:600}}>🗑 Limpiar historial anterior a:</div>
          <div className="row" style={{gap:8}}>
            <input type="date" value={purgeDate} onChange={e=>setPurgeDate(e.target.value)}
              style={{flex:1,background:"var(--s1)",border:"1px solid var(--border)",borderRadius:8,padding:"10px 12px",color:"var(--text)",fontSize:16,outline:"none"}}/>
            <button className="btn btn-d btn-sm" disabled={!purgeDate||purgeCount===0}
              onClick={()=>onPurgeBefore(purgeDate, purgeCount)}>
              {purgeCount>0?`Borrar (${purgeCount})`:"Borrar"}
            </button>
          </div>
          {purgeDate && purgeCount===0 && <p style={{fontSize:12,color:"var(--sub)",marginTop:8}}>No hay reservas anteriores a esa fecha.</p>}
        </div>
      </>}
    </>
  );
}

function ResCard({ res, onOpen, onDelete, onEdit }) {
  const cap=res.courts.length*4;
  const total=res.pool.length+res.courts.reduce((s,c)=>s+c.players.length,0);
  const full=total>=cap;
  return (
    <div className="card">
      <div className="row">
        <div className="spacer">
          <div className="card-title">{res.venue}</div>
          <div className="card-sub">📅 {fmtDate(res.date)} · 🕐 {res.timeStart}–{res.timeEnd}<br/>🎾 {res.courts.length} pista{res.courts.length>1?"s":""} · {cap} plazas</div>
        </div>
        <span className={`badge ${full?"b-red":"b-green"}`}>{total}/{cap}</span>
      </div>
      <div className="prog"><div className={`prog-fill${full?" full":""}`} style={{width:`${Math.min(100,(total/cap)*100)}%`}}/></div>
      <div className="row" style={{marginTop:12,gap:8}}>
        <button className="btn btn-p btn-sm" onClick={()=>onOpen(res.id)}>Gestionar →</button>
        <button className="btn btn-ghost btn-sm" onClick={()=>onEdit(res)}>✏️ Editar</button>
        <div className="spacer"/>
        <button className="btn btn-d btn-sm" onClick={()=>{if(window.confirm("¿Cancelar esta reserva?"))onDelete(res.id);}}>🗑</button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
//  MANAGE TAB
// ──────────────────────────────────────────────────────────────
function ManageTab({ res, withSave, showToast, setModal }) {
  const [playerName, setPlayerName] = useState("");
  const inputRef = useRef(null);

  const cap=res.courts.length*4;
  const allPlayers=[...res.pool,...res.courts.flatMap(c=>c.players)];
  const total=allPlayers.length;
  const isFull=total>=cap;

  const handleAddPlayer = () => {
    const name=playerName.trim();
    if (!name) return;
    if ([...allPlayers,...res.waitlist].some(p=>p.toLowerCase()===name.toLowerCase())) {
      showToast("⚠️ Nombre ya existe"); return;
    }
    const status = isFull ? "espera" : "inscrito";
    withSave(
      () => addPlayer(res.id, name, status),
      isFull ? `${name} → lista de espera ⏳` : `${name} inscrito ✓`
    );
    setPlayerName("");
    setTimeout(()=>inputRef.current?.focus(), 100);
  };

  const handleRemovePlayer = (name) => {
    withSave(() => deletePlayer(res.id, name), `${name} eliminado`);
  };

  const handleCourtField = (courtId, field, val) => {
    withSave(() => updateCourt(courtId, {[field]: val}));
  };

  const handleRemoveCourt = (court) => {
    if (court.players.length>0) { showToast("⚠️ Mueve los jugadores primero"); return; }
    withSave(() => deleteCourt(court.id), "Pista eliminada");
  };

  const handlePromote = (name) => {
    withSave(() => movePlayer(res.id, name, "pool", res.courts), `${name} promovido ✓`);
  };

  return (
    <div>
      {/* Header */}
      <div className="card">
        <div className="row">
          <div className="spacer">
            <div className="card-title">{res.venue}</div>
            <div className="card-sub">{fmtDate(res.date)} · {res.timeStart}–{res.timeEnd} · {res.courts.length} pista{res.courts.length>1?"s":""}</div>
          </div>
          <span className={`badge ${isFull?"b-red":"b-green"}`}>{total}/{cap}</span>
        </div>
        <div className="prog"><div className={`prog-fill${isFull?" full":""}`} style={{width:`${Math.min(100,(total/cap)*100)}%`}}/></div>
        <div className="row" style={{marginTop:12}}>
          <button className="btn btn-ghost btn-sm" onClick={()=>setModal({type:"wa"})}>📲 WhatsApp</button>
        </div>
      </div>

      {/* Add player */}
      <div className="card">
        <div style={{fontFamily:"var(--fd)",fontSize:16,marginBottom:10}}>Inscribir jugador</div>
        <div className="row">
          <input ref={inputRef}
            style={{flex:1,background:"var(--s2)",border:"1px solid var(--border)",borderRadius:10,padding:"12px 14px",color:"var(--text)",fontSize:16,outline:"none"}}
            placeholder="Nombre del jugador"
            value={playerName}
            onChange={e=>setPlayerName(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&handleAddPlayer()}
          />
          <button className="btn btn-p" style={{flexShrink:0}} onClick={handleAddPlayer}>
            {isFull?"Espera":"+ Añadir"}
          </button>
        </div>
        {isFull && <p style={{fontSize:12,color:"var(--danger)",marginTop:7}}>⚠️ Reserva completa — el siguiente irá a lista de espera</p>}
      </div>

      {/* Pool */}
      <div className="pool-box">
        <div className="sh">
          <span className="sh-title">Disponibles para asignar</span>
          <span className="badge b-blue">{res.pool.length}</span>
        </div>
        {res.pool.length===0 && <p style={{color:"var(--sub)",fontSize:13,paddingBottom:4}}>Sin jugadores disponibles</p>}
        {res.pool.map(p=>(
          <div key={p} className="chip">
            <div className="chip-name"><span>👤</span><span>{p}</span></div>
            <div className="row" style={{gap:6}}>
              <button className="chip-movebtn" onClick={()=>setModal({type:"move",player:p,source:"pool"})}>Mover →</button>
              <button className="chip-del" onClick={()=>handleRemovePlayer(p)}>✕</button>
            </div>
          </div>
        ))}

        {res.waitlist.length>0 && <>
          <hr/>
          <div className="sh">
            <span style={{fontSize:11,color:"var(--sub)",fontWeight:700,textTransform:"uppercase",letterSpacing:".5px"}}>Lista de espera ({res.waitlist.length})</span>
          </div>
          {res.waitlist.map(p=>(
            <div key={p} className="chip chip-reserve">
              <div className="chip-name"><span>⏳</span><span>{p}</span></div>
              <div className="row" style={{gap:6}}>
                {!isFull && <button className="chip-movebtn" onClick={()=>handlePromote(p)}>▲ Promover</button>}
                <button className="chip-del" onClick={()=>handleRemovePlayer(p)}>✕</button>
              </div>
            </div>
          ))}
        </>}
      </div>

      {/* Courts */}
      <div className="sh"><span className="sh-title">Pistas reservadas</span></div>
      {res.courts.map(court=>(
        <div key={court.id} className="court-box">
          <div className="court-hd">
            <input
              defaultValue={court.name}
              onBlur={e=>handleCourtField(court.id,"name",e.target.value)}
              style={{fontFamily:"var(--fd)",fontSize:16,color:"var(--info)",background:"transparent",border:"none",borderBottom:"1px solid var(--border)",outline:"none",flex:1,minWidth:0,padding:"2px 4px"}}
              placeholder="Nombre pista"
            />
            <div className="row" style={{gap:6,marginLeft:8,flexShrink:0}}>
              <span className={`badge ${court.players.length>=4?"b-red":"b-green"}`}>{court.players.length}/4</span>
              <button className="btn btn-d btn-xs" onClick={()=>handleRemoveCourt(court)}>🗑</button>
            </div>
          </div>
          <div className="court-fields">
            <div>
              <label>Precio €</label>
              <input type="number" defaultValue={court.price}
                onBlur={e=>handleCourtField(court.id,"price",parseFloat(e.target.value)||0)}/>
            </div>
            <div>
              <label>A pagar a:</label>
              <input defaultValue={court.payTo} placeholder="Nombre"
                onBlur={e=>handleCourtField(court.id,"payTo",e.target.value)}/>
            </div>
          </div>
          <div className={`court-slot ${court.players.length===0?"empty-hl":""}`}>
            {court.players.length===0 && <p style={{color:"var(--sub)",fontSize:12,textAlign:"center",padding:"6px 0"}}>Pulsa "Mover →" en un jugador disponible</p>}
            {court.players.map(p=>(
              <div key={p} className="chip" style={{background:"var(--s2)",marginBottom:5}}>
                <div className="chip-name"><span>👤</span><span>{p}</span></div>
                <div className="row" style={{gap:6}}>
                  <button className="chip-movebtn" onClick={()=>setModal({type:"move",player:p,source:court.id})}>Mover →</button>
                  <button className="chip-del" onClick={()=>handleRemovePlayer(p)}>✕</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
//  MOVE MODAL
// ──────────────────────────────────────────────────────────────
function MoveModal({ player, source, res, onMove, onClose }) {
  const opts = [
    {id:"pool", label:"👥 Disponibles", sub:"Pool sin asignar", dis:source==="pool"},
    ...res.courts.map(c=>({
      id:c.id, label:`🎾 ${c.name}`,
      sub: c.players.length>=4?"Llena (4/4)":`${c.players.length}/4 jugadores`,
      dis: source===c.id || c.players.length>=4,
    })),
  ];
  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="sheet">
        <div className="sheet-handle"/>
        <h2>Mover jugador</h2>
        <p style={{color:"var(--sub)",fontSize:13,marginBottom:12}}>¿Dónde asignas a <strong style={{color:"var(--text)"}}>{player}</strong>?</p>
        <ul className="move-list">
          {opts.map(o=>(
            <li key={o.id} className={`move-item ${o.dis?"dis":""}`} onClick={()=>!o.dis&&onMove(o.id)}>
              <div>
                <div style={{fontWeight:600}}>{o.label}</div>
                <div style={{fontSize:11,color:"var(--sub)",marginTop:2}}>{o.sub}</div>
              </div>
              {!o.dis && <span style={{color:"var(--accent)",fontSize:18}}>→</span>}
            </li>
          ))}
        </ul>
        <button className="btn btn-ghost btn-block" style={{marginTop:4}} onClick={onClose}>Cancelar</button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
//  WHATSAPP MODAL
// ──────────────────────────────────────────────────────────────
function WAModal({ res, onClose, showToast }) {
  const [mode, setMode] = useState("status");
  const cap=res.courts.length*4;
  const allPlayers=[...res.pool,...res.courts.flatMap(c=>c.players)];
  const total=allPlayers.length;

  const getText = () => {
    const hdr=`🎾 *${res.venue}*\n📅 ${fmtDate(res.date)}  |  🕐 ${res.timeStart} - ${res.timeEnd}\n`;
    if (mode==="status") {
      const list=allPlayers.map((p,i)=>`${i+1}. ${p}`).join("\n");
      const libres=cap-total;
      const estado=libres>0?`\n❗ Faltan *${libres}* jugadores para completar la reserva`:"\n✅ *¡Reserva completa!*";
      const wl=res.waitlist.length>0?`\n\n📋 *Lista de espera:*\n${res.waitlist.join(", ")}`:"";
      return `${hdr}\n👥 *Jugadores (${total}/${cap}):*\n${list||"—"}${estado}${wl}`;
    } else {
      const pistas=res.courts.map(c=>{
        const ps=c.players.length?c.players.join(", "):"—";
        return `🎾 *${c.name}*  |  ${c.price}€  |  A pagar a: *${c.payTo||"—"}*\n${ps}`;
      }).join("\n\n");
      return `${hdr}\n${pistas}`;
    }
  };

  const copyText = async () => {
    const text = getText();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showToast("📋 Copiado ✓"); return;
      }
    } catch {}
    try {
      const el=document.createElement("textarea");
      el.value=text; el.setAttribute("readonly","");
      el.style.cssText="position:absolute;left:-9999px;top:0;";
      document.body.appendChild(el);
      el.focus(); el.setSelectionRange(0,el.value.length);
      const ok=document.execCommand("copy");
      document.body.removeChild(el);
      showToast(ok?"📋 Copiado ✓":"⚠️ Copia el texto manualmente");
    } catch { showToast("⚠️ Copia el texto manualmente"); }
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="sheet">
        <div className="sheet-handle"/>
        <h2>📲 WhatsApp</h2>
        <div className="seg">
          <button className={`seg-btn ${mode==="status"?"active":""}`} onClick={()=>setMode("status")}>Estado</button>
          <button className={`seg-btn ${mode==="final"?"active":""}`} onClick={()=>setMode("final")}>Partidos</button>
        </div>
        <div className="wa-box">{getText()}</div>
        <div className="row" style={{marginTop:12,gap:8}}>
          <button className="btn btn-ghost" style={{flex:1}} onClick={onClose}>Cerrar</button>
          <button className="btn btn-p" style={{flex:2}} onClick={copyText}>📋 Copiar</button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
//  RESERVATION MODAL (crear / editar)
// ──────────────────────────────────────────────────────────────
function ResModal({ onClose, onSave, existing }) {
  const today=new Date().toISOString().split("T")[0];
  const [form,setForm]=useState(existing?{
    venue:existing.venue, date:existing.date, timeStart:existing.timeStart, timeEnd:existing.timeEnd,
    numCourts:String(existing.courts.length),
    firstCourt:existing.courts[0]?.name||"Pista 14",
    price:String(existing.courts[0]?.price||6),
  }:{venue:"",date:today,timeStart:"18:30",timeEnd:"20:00",numCourts:"2",firstCourt:"Pista 14",price:"6"});

  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const valid=form.venue&&form.date&&form.timeStart&&form.timeEnd&&parseInt(form.numCourts)>0;
  const newCount=parseInt(form.numCourts)||0;
  const removing=existing&&newCount<existing.courts.length;
  const toRemove=removing?existing.courts.slice(newCount):[];
  const hasPlayers=toRemove.some(c=>c.players.length>0);

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="sheet">
        <div className="sheet-handle"/>
        <h2>{existing?"Editar reserva":"Nueva reserva"}</h2>

        <div className="field"><label>Recinto</label>
          <input placeholder="Ej: Puerta Hierro" value={form.venue} onChange={e=>set("venue",e.target.value)}/>
        </div>
        <div className="field"><label>Fecha</label>
          <input type="date" value={form.date} onChange={e=>set("date",e.target.value)}/>
        </div>
        <div className="fg2">
          <div className="field"><label>Hora inicio</label>
            <input type="time" value={form.timeStart} onChange={e=>set("timeStart",e.target.value)}/>
          </div>
          <div className="field"><label>Hora fin</label>
            <input type="time" value={form.timeEnd} onChange={e=>set("timeEnd",e.target.value)}/>
          </div>
        </div>
        <div className="fg2">
          <div className="field"><label>Nº pistas</label>
            <input type="number" min="1" max="10" value={form.numCourts} onChange={e=>set("numCourts",e.target.value)}/>
          </div>
          <div className="field"><label>Precio €</label>
            <input type="number" step="0.5" value={form.price} onChange={e=>set("price",e.target.value)}/>
          </div>
        </div>
        <div className="field"><label>Nombre de la 1ª pista (ej: Pista 14, Court A…)</label>
          <input type="text" placeholder="Ej: Pista 14" value={form.firstCourt} onChange={e=>set("firstCourt",e.target.value)}/>
        </div>

        {valid && <div className="info-box">Capacidad: <strong style={{color:"var(--accent)"}}>{newCount*4} jugadores</strong> en {form.numCourts} pista{newCount!==1?"s":""}</div>}
        {removing && hasPlayers && <div className="warn-box">⚠️ Las pistas a eliminar tienen jugadores. Muévelos antes.</div>}

        <div className="row" style={{gap:8}}>
          <button className="btn btn-ghost" style={{flex:1}} onClick={onClose}>Cancelar</button>
          <button className="btn btn-p" style={{flex:2}} disabled={!valid||(removing&&hasPlayers)} onClick={()=>onSave(form)}>
            {existing?"Guardar cambios":"Crear reserva"}
          </button>
        </div>
      </div>
    </div>
  );
}
