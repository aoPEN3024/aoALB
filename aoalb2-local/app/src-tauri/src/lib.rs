//! Tauri シェル：画面（app/ui）からのコマンドを aoalb_core へ渡すだけの薄い層。
//! 業務ロジックは aoalb_core、画面ロジックは app/ui にあり、この層には置かない。

use aoalb_core::classify::{self, FieldChange, OverrideState};
use aoalb_core::exchange::{self, ImportMode};
use aoalb_core::ledger::{self, Op};
use aoalb_core::photos::{self, ImportOptions, ImportSource, PhotoFilter};
use aoalb_core::project::{self, NewProject, Project};
use aoalb_core::util::{Cancel, Progress};
use aoalb_core::{backup, pdf, AppError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

type Res<T> = std::result::Result<T, AppError>;

#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Settings {
    device_id: String,
    recent: Vec<RecentProject>,
    default_parent: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RecentProject {
    uuid: String,
    name: String,
    root: String,
    opened_at: String,
}

struct Inner {
    project: Option<Project>,
    thumb_stop: Option<Arc<AtomicBool>>,
}

struct AppState {
    /// 画像配信用：今開いている工事フォルダ（画像の要求ごとにDBの鍵を取らないよう分けて持つ）
    image_root: Mutex<Option<PathBuf>>,
    inner: Mutex<Inner>,
    tasks: Mutex<HashMap<String, Cancel>>,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
}

fn save_settings(state: &AppState) {
    if let Ok(s) = state.settings.lock() {
        if let Ok(bytes) = serde_json::to_vec_pretty(&*s) {
            let _ = aoalb_core::util::write_atomic(&state.settings_path, &bytes);
        }
    }
}

fn with_project<T>(state: &State<AppState>, f: impl FnOnce(&mut Project) -> Res<T>) -> Res<T> {
    let mut g = state.inner.lock().map_err(|_| AppError::internal("lock"))?;
    let p = g.project.as_mut().ok_or_else(|| AppError::invalid("工事を開いてください。"))?;
    f(p)
}

fn task(state: &State<AppState>, id: &str) -> Cancel {
    let c = Cancel::new();
    state.tasks.lock().unwrap().insert(id.into(), c.clone());
    c
}
fn end_task(state: &State<AppState>, id: &str) {
    state.tasks.lock().unwrap().remove(id);
}

fn emitter(app: &AppHandle, task_id: &str) -> impl FnMut(Progress) {
    let app = app.clone();
    let id = task_id.to_string();
    move |p: Progress| {
        let _ = app.emit("task-progress", json!({"taskId": id, "progress": p}));
    }
}

/// サムネイル作成をバックグラウンドで行う（工事ごとに1本。画面操作を止めない）
fn start_thumbnail_worker(app: AppHandle, root: PathBuf) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    let s = stop.clone();
    std::thread::spawn(move || {
        let Ok(conn) = aoalb_core::db::open(&root.join(project::DB_FILE)) else { return };
        let cancel = Cancel::new();
        while !s.load(Ordering::SeqCst) {
            let before: Vec<String> = conn
                .prepare("select uuid from photos where thumb_state = 'pending' and deleted_at is null order by photo_number limit 12")
                .and_then(|mut st| st.query_map([], |r| r.get(0)).and_then(|rows| rows.collect()))
                .unwrap_or_default();
            if before.is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(700));
                continue;
            }
            match photos::process_pending_thumbnails(&conn, &root, 12, &cancel) {
                Ok(n) if n > 0 => {
                    let _ = app.emit("thumbnails-ready", json!({"uuids": before}));
                }
                _ => std::thread::sleep(std::time::Duration::from_millis(700)),
            }
        }
    });
    stop
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectState {
    info: project::ProjectInfo,
    root: String,
    thumb_dir: String,
    original_dir: String,
    report: Option<project::OpenReport>,
}

fn opened(app: &AppHandle, state: &State<AppState>, p: Project, report: Option<project::OpenReport>) -> Res<ProjectState> {
    let info = p.info()?;
    let root = p.root.clone();
    *state.image_root.lock().unwrap() = Some(root.clone());
    let mut g = state.inner.lock().unwrap();
    if let Some(old) = g.project.take() {
        let _ = old.close();
    }
    if let Some(s) = g.thumb_stop.take() {
        s.store(true, Ordering::SeqCst);
    }
    g.thumb_stop = Some(start_thumbnail_worker(app.clone(), root.clone()));
    g.project = Some(p);
    drop(g);
    {
        let mut s = state.settings.lock().unwrap();
        let r = root.to_string_lossy().to_string();
        s.recent.retain(|x| x.uuid != info.uuid && x.root != r);
        s.recent.insert(0, RecentProject { uuid: info.uuid.clone(), name: info.name.clone(), root: r, opened_at: aoalb_core::util::now() });
        s.recent.truncate(20);
        s.default_parent = root.parent().map(|x| x.to_string_lossy().to_string());
    }
    save_settings(state);
    Ok(ProjectState {
        thumb_dir: root.join("thumbnails").to_string_lossy().into(),
        original_dir: root.join("originals").to_string_lossy().into(),
        root: root.to_string_lossy().into(),
        info,
        report,
    })
}

// ------------------------------------------------------------ 工事

#[tauri::command]
fn app_info(state: State<AppState>) -> Value {
    let s = state.settings.lock().unwrap().clone();
    let recent: Vec<Value> = s.recent.iter().map(|r| json!({"uuid": r.uuid, "name": r.name, "root": r.root, "openedAt": r.opened_at, "exists": Path::new(&r.root).join(project::MARKER_FILE).exists()})).collect();
    json!({"version": project::APP_VERSION, "recent": recent, "defaultParent": s.default_parent})
}

#[tauri::command]
fn project_create(app: AppHandle, state: State<AppState>, parent: String, input: NewProject) -> Res<ProjectState> {
    let device = state.settings.lock().unwrap().device_id.clone();
    let p = project::create_project(Path::new(&parent), &input, &device)?;
    opened(&app, &state, p, None)
}

#[tauri::command]
fn project_open(app: AppHandle, state: State<AppState>, root: String) -> Res<ProjectState> {
    let device = state.settings.lock().unwrap().device_id.clone();
    // 既に開いている同じ工事なら閉じてから開き直す
    {
        let mut g = state.inner.lock().unwrap();
        if g.project.as_ref().map(|p| p.root == Path::new(&root)).unwrap_or(false) {
            if let Some(p) = g.project.take() {
                let _ = p.close();
            }
        }
    }
    let (p, report) = project::open_project(Path::new(&root), &device)?;
    opened(&app, &state, p, Some(report))
}

#[tauri::command]
fn project_close(state: State<AppState>) -> Res<()> {
    *state.image_root.lock().unwrap() = None;
    let mut g = state.inner.lock().unwrap();
    if let Some(s) = g.thumb_stop.take() {
        s.store(true, Ordering::SeqCst);
    }
    if let Some(p) = g.project.take() {
        let _ = backup::periodic_if_due(&p, 0);
        p.close()?;
    }
    Ok(())
}

#[tauri::command]
fn project_update(state: State<AppState>, input: NewProject) -> Res<project::ProjectInfo> {
    with_project(&state, |p| p.update_info(&input))
}

#[tauri::command]
fn forget_recent(state: State<AppState>, root: String) {
    state.settings.lock().unwrap().recent.retain(|r| r.root != root);
    save_settings(&state);
}

// ------------------------------------------------------------ 写真

#[tauri::command]
async fn photos_import(app: AppHandle, state: State<'_, AppState>, task_id: String, source: ImportSource, options: ImportOptions) -> Res<photos::ImportResult> {
    let cancel = task(&state, &task_id);
    let mut prog = emitter(&app, &task_id);
    let r = with_project(&state, |p| {
        let _ = backup::periodic_if_due(p, 0);
        photos::import(p, &source, options, &cancel, &mut prog)
    });
    end_task(&state, &task_id);
    r
}

#[tauri::command]
async fn import_retry(app: AppHandle, state: State<'_, AppState>, task_id: String, ids: Vec<i64>, options: ImportOptions) -> Res<photos::ImportResult> {
    let cancel = task(&state, &task_id);
    let mut prog = emitter(&app, &task_id);
    let r = with_project(&state, |p| photos::retry_failures(p, &ids, options, &cancel, &mut prog));
    end_task(&state, &task_id);
    r
}

#[tauri::command]
fn import_failures(state: State<AppState>, batch: Option<String>) -> Res<Vec<photos::ImportFailure>> {
    with_project(&state, |p| photos::list_failures(&p.conn, batch.as_deref()))
}

#[tauri::command]
fn photos_list(state: State<AppState>, filter: PhotoFilter) -> Res<Vec<photos::PhotoRow>> {
    with_project(&state, |p| photos::list_photos(&p.conn, &filter))
}

#[tauri::command]
fn photo_detail(state: State<AppState>, uuid: String) -> Res<photos::PhotoDetail> {
    with_project(&state, |p| photos::photo_detail(p, &uuid))
}

#[tauri::command]
fn photos_trash(state: State<AppState>, uuids: Vec<String>) -> Res<usize> {
    with_project(&state, |p| photos::trash_photos(p, &uuids))
}

#[tauri::command]
fn photos_restore(state: State<AppState>, uuids: Vec<String>) -> Res<usize> {
    with_project(&state, |p| photos::restore_photos(p, &uuids))
}

#[tauri::command]
fn folder_labels(state: State<AppState>) -> Res<Vec<photos::FolderCount>> {
    with_project(&state, |p| photos::folder_labels(&p.conn))
}

#[tauri::command]
fn thumbnails_rebuild(state: State<AppState>) -> Res<usize> {
    with_project(&state, |p| photos::reset_thumbnails(&p.conn, &p.root))
}

// ------------------------------------------------------------ 分類

#[tauri::command]
fn classify_apply(state: State<AppState>, photo_uuids: Vec<String>, changes: BTreeMap<String, FieldChange>) -> Res<Vec<OverrideState>> {
    with_project(&state, |p| classify::apply(p, &photo_uuids, &changes))
}

#[tauri::command]
fn classify_restore(state: State<AppState>, states: Vec<OverrideState>) -> Res<Vec<OverrideState>> {
    with_project(&state, |p| classify::restore_states(p, &states))
}

#[tauri::command]
fn folder_classification_preview(state: State<AppState>) -> Res<classify::FolderClassificationPreview> {
    with_project(&state, |p| classify::folder_classification_preview(&p.conn))
}

#[tauri::command]
fn folder_classification_apply(state: State<AppState>) -> Res<classify::FolderClassificationResult> {
    with_project(&state, |p| {
        let preview = classify::folder_classification_preview(&p.conn)?;
        if preview.photo_count > 0 {
            backup::create(p, backup::Reason::BeforeFolderClassification)?;
        }
        classify::apply_folder_classification(p)
    })
}

#[tauri::command]
fn classify_meta(state: State<AppState>) -> Res<Value> {
    with_project(&state, |p| {
        let mut sugg = serde_json::Map::new();
        for f in photos::FIELDS {
            sugg.insert(f.into(), json!(classify::suggestions(&p.conn, f)?));
        }
        Ok(json!({"suggestions": sugg, "recent": classify::recent(&p.conn)?, "templates": classify::templates(&p.conn)?}))
    })
}

#[tauri::command]
fn template_save(state: State<AppState>, uuid: Option<String>, name: String, values: BTreeMap<String, String>) -> Res<classify::Template> {
    with_project(&state, |p| classify::save_template(p, uuid, &name, &values))
}

#[tauri::command]
fn template_delete(state: State<AppState>, uuid: String) -> Res<()> {
    with_project(&state, |p| classify::delete_template(p, &uuid))
}

// ------------------------------------------------------------ 台帳

#[tauri::command]
fn ledgers_list(state: State<AppState>, trashed: bool) -> Res<Vec<ledger::LedgerSummary>> {
    with_project(&state, |p| ledger::list(&p.conn, trashed))
}

#[tauri::command]
fn ledger_create(state: State<AppState>, title: String) -> Res<ledger::LedgerDetail> {
    with_project(&state, |p| ledger::create(p, &title, 1))
}

#[tauri::command]
fn ledger_detail(state: State<AppState>, uuid: String) -> Res<ledger::LedgerDetail> {
    with_project(&state, |p| ledger::detail(&p.conn, &uuid))
}

#[tauri::command]
fn ledger_apply(state: State<AppState>, uuid: String, ops: Vec<Op>) -> Res<ledger::ApplyResult> {
    with_project(&state, |p| ledger::apply_ops(p, &uuid, &ops))
}

#[tauri::command]
fn ledger_trash(state: State<AppState>, uuid: String) -> Res<()> {
    with_project(&state, |p| {
        backup::create(p, backup::Reason::BeforeLedgerDelete)?;
        ledger::trash(p, &uuid)
    })
}
#[tauri::command]
fn ledger_restore(state: State<AppState>, uuid: String) -> Res<()> {
    with_project(&state, |p| ledger::restore(p, &uuid))
}
#[tauri::command]
fn ledger_purge(state: State<AppState>, uuid: String) -> Res<()> {
    with_project(&state, |p| {
        backup::create(p, backup::Reason::BeforeLedgerDelete)?;
        ledger::purge(p, &uuid)
    })
}
#[tauri::command]
fn ledger_duplicate(state: State<AppState>, uuid: String, title: String) -> Res<ledger::LedgerDetail> {
    with_project(&state, |p| ledger::duplicate(p, &uuid, &title))
}

#[tauri::command]
async fn pdf_export(app: AppHandle, state: State<'_, AppState>, task_id: String, ledger_uuid: String, dest: Option<String>, open: bool) -> Res<pdf::PdfReport> {
    let cancel = task(&state, &task_id);
    let mut prog = emitter(&app, &task_id);
    let r = with_project(&state, |p| {
        let dest = match dest {
            Some(d) => PathBuf::from(d),
            None => {
                let title = ledger::detail(&p.conn, &ledger_uuid)?.title;
                p.root.join("exports").join(format!("{}.pdf", aoalb_core::util::safe_name(&title, "台帳")))
            }
        };
        pdf::export_ledger_pdf(p, &ledger_uuid, &dest, &cancel, &mut prog)
    });
    end_task(&state, &task_id);
    let r = r?;
    if open {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_path(r.path.clone(), None::<&str>);
    }
    Ok(r)
}

#[tauri::command]
fn pdf_estimate(state: State<AppState>, ledger_uuid: String) -> Res<pdf::PdfEstimate> {
    with_project(&state, |p| pdf::estimate(p, &ledger_uuid, pdf::PDF_MAX_BYTES))
}

// ------------------------------------------------------------ 引継ぎ

#[tauri::command]
fn exchange_plan(state: State<AppState>, dest_dir: String) -> Res<exchange::ExportPlan> {
    with_project(&state, |p| exchange::plan_export(p, Path::new(&dest_dir)))
}

#[tauri::command]
async fn exchange_export(app: AppHandle, state: State<'_, AppState>, task_id: String, dest: String) -> Res<exchange::ExportReport> {
    let cancel = task(&state, &task_id);
    let mut prog = emitter(&app, &task_id);
    let r = with_project(&state, |p| exchange::export(p, Path::new(&dest), &cancel, &mut prog));
    end_task(&state, &task_id);
    r
}

#[tauri::command]
fn exchange_preview(state: State<AppState>, file: String, dest_parent: String) -> Res<exchange::ImportPreview> {
    let known: Vec<PathBuf> = state.settings.lock().unwrap().recent.iter().map(|r| PathBuf::from(&r.root)).collect();
    exchange::preview(Path::new(&file), &known, Path::new(&dest_parent))
}

#[tauri::command]
async fn exchange_import(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    file: String,
    dest_parent: String,
    mode: ImportMode,
) -> Res<ProjectState> {
    let cancel = task(&state, &task_id);
    let mut prog = emitter(&app, &task_id);
    let device = state.settings.lock().unwrap().device_id.clone();
    // 置き換え対象が開いていれば閉じる
    if let ImportMode::Replace { root, .. } = &mode {
        let mut g = state.inner.lock().unwrap();
        if g.project.as_ref().map(|p| p.root == *root).unwrap_or(false) {
            if let Some(s) = g.thumb_stop.take() {
                s.store(true, Ordering::SeqCst);
            }
            if let Some(p) = g.project.take() {
                p.close()?;
            }
        }
    }
    let r = exchange::import(Path::new(&file), Path::new(&dest_parent), mode, &device, &cancel, &mut prog);
    end_task(&state, &task_id);
    let r = r?;
    let (p, report) = project::open_project(Path::new(&r.root), &device)?;
    opened(&app, &state, p, Some(report))
}

// ------------------------------------------------------------ バックアップ

#[tauri::command]
fn backup_status(state: State<AppState>) -> Res<Value> {
    with_project(&state, |p| Ok(json!({"status": backup::status(p)?, "list": backup::list(p)?})))
}
#[tauri::command]
fn backup_create(state: State<AppState>) -> Res<backup::BackupInfo> {
    with_project(&state, |p| backup::create(p, backup::Reason::Manual))
}
#[tauri::command]
fn backup_periodic(state: State<AppState>) -> Res<Option<backup::BackupInfo>> {
    with_project(&state, |p| backup::periodic_if_due(p, 10))
}
#[tauri::command]
fn backup_verify(state: State<AppState>, name: String) -> Res<backup::VerifyReport> {
    with_project(&state, |p| backup::verify(p, &name))
}
#[tauri::command]
fn backup_restore(state: State<AppState>, name: String) -> Res<backup::RestoreReport> {
    with_project(&state, |p| backup::restore(p, &name))
}
#[tauri::command]
fn recover_unregistered(state: State<AppState>) -> Res<aoalb_core::recover::RecoveryReport> {
    with_project(&state, |p| aoalb_core::recover::recover_unregistered(p, &Cancel::new()))
}
#[tauri::command]
fn about() -> Value {
    json!({"version": project::APP_VERSION, "font": pdf::BUNDLED_FONT_NAME, "fontLicense": pdf::BUNDLED_FONT_LICENSE})
}

/// 計測用の自動操作（環境変数 AOALB2_E2E_PROJECT と AOALB2_E2E_OUT を両方指定した時だけ有効。通常は何もしない）
#[tauri::command]
fn e2e_config() -> Value {
    let project = std::env::var("AOALB2_E2E_PROJECT").ok();
    let enabled = project.is_some() && std::env::var("AOALB2_E2E_OUT").is_ok();
    json!({"enabled": enabled, "project": if enabled { project } else { None }})
}

#[tauri::command]
fn e2e_report(app: AppHandle, report: Value) -> Res<()> {
    let out = std::env::var("AOALB2_E2E_OUT").map_err(|_| AppError::invalid("計測用ではありません。"))?;
    aoalb_core::util::write_atomic(Path::new(&out), &serde_json::to_vec_pretty(&report).unwrap_or_default())?;
    let state: State<AppState> = app.state();
    let _ = project_close(state);
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn task_cancel(state: State<AppState>, task_id: String) {
    if let Some(c) = state.tasks.lock().unwrap().get(&task_id) {
        c.cancel();
    }
}

#[tauri::command]
fn reveal(app: AppHandle, path: String) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().reveal_item_in_dir(path);
}

/// 写真の配信：aoimg://localhost/t/{写真ID}（サムネイル）・/o/{写真ID}（原寸）。
/// 今開いている工事の originals/・thumbnails/ にある「写真ID.jpg」だけを返す（他のファイルは読めない）。
/// 画面側に画像を溜めないよう no-store を付ける。
fn image_response(app: &AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    let deny = |code: u16| tauri::http::Response::builder().status(code).body(Vec::new()).unwrap();
    let path = path.trim_start_matches('/');
    let Some((kind, rest)) = path.split_once('/') else { return deny(404) };
    let id = rest.trim_end_matches(".jpg");
    if !aoalb_core::util::is_uuid(id) {
        return deny(404);
    }
    let dir = match kind {
        "t" => "thumbnails",
        "o" => "originals",
        _ => return deny(404),
    };
    let state: State<AppState> = app.state();
    let Some(root) = state.image_root.lock().unwrap().clone() else { return deny(404) };
    match std::fs::read(root.join(dir).join(format!("{id}.jpg"))) {
        Ok(bytes) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", "image/jpeg")
            .header("Cache-Control", "no-store")
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap(),
        Err(_) => deny(404),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("aoimg", |ctx, req| image_response(ctx.app_handle(), req.uri().path()))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
            std::fs::create_dir_all(&dir).ok();
            let settings_path = dir.join("settings.json");
            let mut settings: Settings = std::fs::read(&settings_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            // 端末識別子（最終編集端末の記録用。個人情報は含めない）
            if settings.device_id.is_empty() {
                settings.device_id = format!("pc-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
            }
            let state = AppState {
                image_root: Mutex::new(None),
                inner: Mutex::new(Inner { project: None, thumb_stop: None }),
                tasks: Mutex::new(HashMap::new()),
                settings: Mutex::new(settings),
                settings_path,
            };
            save_settings(&state);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            project_create,
            project_open,
            project_close,
            project_update,
            forget_recent,
            photos_import,
            import_retry,
            import_failures,
            photos_list,
            photo_detail,
            photos_trash,
            photos_restore,
            folder_labels,
            thumbnails_rebuild,
            classify_apply,
            classify_restore,
            folder_classification_preview,
            folder_classification_apply,
            classify_meta,
            template_save,
            template_delete,
            ledgers_list,
            ledger_create,
            ledger_detail,
            ledger_apply,
            ledger_trash,
            ledger_restore,
            ledger_purge,
            ledger_duplicate,
            pdf_export,
            pdf_estimate,
            exchange_plan,
            exchange_export,
            exchange_preview,
            exchange_import,
            backup_status,
            backup_create,
            backup_periodic,
            backup_verify,
            backup_restore,
            recover_unregistered,
            about,
            task_cancel,
            reveal,
            e2e_config,
            e2e_report
        ])
        .run(tauri::generate_context!())
        .expect("aoALB2 を起動できませんでした");
}
