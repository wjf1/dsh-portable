/**
 * dsh-portable — settings panel.
 *
 * Hand-written bundle: the host loads it through \`window.__ModuleLoader__.load\`,
 * the same contract the first-party panels use. No build step, because a plugin
 * whose panel needs a bundler before it renders is a plugin that breaks in the
 * one situation it exists for — moving to a machine with no toolchain.
 *
 * React is \`require\`d from the host rather than bundled, for the same reason:
 * one copy of React must own the tree.
 *
 * The panel has no modal and no router. Long work (export, preview, import) is a
 * job on the server; the panel polls it and shows what the server reports. That
 * keeps a half-finished import from looking finished when the tab closes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-portable',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useCallback = React.useCallback;

    const NS = 'dsh-portable';
    const API_PREFIX = '/dsh-portable/api';

    // `call` and the upload path live outside the section component, so the
    // active locale is mirrored here instead of being read through `t`.
    let activeLocale = 'en';

    function loc(key) {
      const table = activeLocale === 'zh' ? zh : en;
      return typeof table[key] === 'string' ? table[key] : key;
    }

    // A missing host half shows up as a bare 404: the panel is rendered by the
    // client bundle, so the sections stay visible while every request fails.
    // Say what that means instead of leaking the status code.
    function describeFailure(response, data) {
      if (data !== null && typeof data.error === 'string' && data.error !== '') return data.error;
      if (response.status === 404) return loc('err.hostMissing');
      if (response.status === 403) return loc('err.forbidden');
      return 'HTTP ' + response.status;
    }

    /* ------------------------------------------------------------- i18n */

    const zh = {
      'section.label': '便携迁移',
      'section.hint': '把当前 profile 的配置、插件、技能与钩子打包成一个文件，在另一台机器上导入还原。',
      'export.title': '导出',
      'export.name': '文件名',
      'export.namePlaceholder': '留空则按时间生成',
      'export.create': '创建包',
      'export.options': '包含内容',
      'export.running': '正在打包',
      'export.done': '已创建包',
      'opt.nodeModules': '已装插件（node_modules）',
      'opt.sourceMaps': '源码映射（.map）',
      'opt.sessions': '会话记录（含对话文本）',
      'opt.runtimes': '已下载运行时（通常很大）',
      'opt.credentials': '凭据文件（含密钥）',
      'opt.credentialsWarn': '包里会带上密钥与登录态，只在可信的机器之间传递。',
      'opt.backups': '配置备份（.bak）',
      'packages.title': '包',
      'packages.empty': '还没有包。导出一个，或者从另一台机器上传一个。',
      'packages.refresh': '刷新',
      'act.download': '下载',
      'act.downloadHint': '把包下载到本机，便于用 U 盘或文件传输拷到另一台机器导入',
      'act.select': '选择',
      'act.selectHint': '选中这个包，然后在下面的「导入」里执行',
      'act.import': '导入',
      'act.share': '分享',
      'act.delete': '删除',
      'act.confirm': '确认删除',
      'act.cancel': '取消',
      'import.title': '导入',
      'import.pick': '先在上面的列表里选一个包。',
      'import.selected': '当前选择',
      'import.mode': '写入方式',
      'mode.merge': '合并（只增不减）',
      'mode.replace': '替换（先移到备份）',
      'import.preview': '预览变更',
      'import.apply': '执行导入',
      'import.confirmTitle': '确认写入？',
      'import.confirmBody': '将把选中的包写入 DSH 主目录（写入方式：',
      'import.confirmBodyTail': '）。写之前会先备份将被改动的配置。',
      'import.confirm': '确认导入',
      'import.confirmHint': '这一步会覆盖目标目录里的同名文件。',
      'import.plan': '变更计划',
      'import.done': '导入结果',
      'restart.hint': '需要重启 DSH 才会生效',
      'import.applied': '已应用',
      'import.rewritten': '重写路径',
      'import.backupDir': '备份目录',
      'import.warnings': '警告',
      'import.none': '（无）',
      'import.merged': '插件清单合并',
      'share.title': '局域网分享',
      'share.none': '当前没有分享。点某个包的「分享」生成一次性链接。',
      'share.hint': '链接只允许下载一次，默认 60 分钟后失效。',
      'share.remaining': '剩余下载',
      'share.expires': '到期',
      'share.stop': '停止',
      'share.copy': '复制链接',
      'share.copied': '已复制',
      'share.copyFailed': '复制失败：请手动选中链接复制。',
      'backups.title': '备份',
      'backups.none': '还没有备份。导入会自动备份它将要改动的配置。',
      'backups.restore': '恢复',
      'backups.restoreConfirm': '确认恢复',
      'backups.restoreHint': '把这份备份里的配置写回 DSH 主目录；写回之前会先把当前文件另存一份。',
      'backups.restored': '已恢复',
      'upload.title': '上传包',
      'upload.send': '上传到本机',
      'upload.hint': '单个 .dshpkg 文件，最大 8 GiB。',
      'upload.progress': '正在上传',
      'upload.done': '上传完成',
      'upload.failed': '上传失败',
      'state.running': '进行中',
      'state.done': '完成',
      'state.succeeded': '完成',
      'state.failed': '失败',
      'state.cancelled': '已取消',
      'msg.loadFailed': '读取状态失败',
      'msg.actionFailed': '操作失败',
      'err.hostMissing': '宿主端未加载：插件可能没装完，或者装好后还没重启 DSH。',
      'err.forbidden': '请求被宿主拒绝：请在 DSH 窗口里打开这个面板。',
      'files': '个文件',
      'busy': '已有打包任务在运行，等它结束。',
    };

    const en = {
      'section.label': 'Portable',
      'section.hint': 'Pack this profile — configuration, plugins, skills, hooks — into one file, then restore it on another machine.',
      'export.title': 'Export',
      'export.name': 'File name',
      'export.namePlaceholder': 'leave empty for a timestamped name',
      'export.create': 'Create package',
      'export.options': 'Contents',
      'export.running': 'Packing',
      'export.done': 'Package created',
      'opt.nodeModules': 'installed plugins (node_modules)',
      'opt.sourceMaps': 'source maps (.map)',
      'opt.sessions': 'session logs (conversation text)',
      'opt.runtimes': 'downloaded runtimes (usually large)',
      'opt.credentials': 'credentials file (holds secrets)',
      'opt.credentialsWarn': 'The package will carry secrets and login state; move it only between machines you trust.',
      'opt.backups': 'config backups (.bak)',
      'packages.title': 'Packages',
      'packages.empty': 'No packages yet. Export one, or upload one from another machine.',
      'packages.refresh': 'Refresh',
      'act.download': 'Download',
      'act.downloadHint': 'Save the package to this machine so it can ride a USB stick to another one',
      'act.select': 'Select',
      'act.selectHint': 'Select this package, then run the import below',
      'act.import': 'Import',
      'act.share': 'Share',
      'act.delete': 'Delete',
      'act.confirm': 'Confirm delete',
      'act.cancel': 'Cancel',
      'import.title': 'Import',
      'import.pick': 'Pick a package from the list above first.',
      'import.selected': 'Selected',
      'import.mode': 'Write mode',
      'mode.merge': 'Merge (adds, never deletes)',
      'mode.replace': 'Replace (moves the old aside)',
      'import.preview': 'Preview changes',
      'import.apply': 'Run import',
      'import.confirmTitle': 'Write now?',
      'import.confirmBody': 'The selected package will be written into the DSH home (write mode: ',
      'import.confirmBodyTail': '). The configuration it touches is backed up first.',
      'import.confirm': 'Yes, import',
      'import.confirmHint': 'This overwrites files of the same name in the target tree.',
      'import.plan': 'Change plan',
      'import.done': 'Import result',
      'restart.hint': 'Restart DSH for the changes to take effect',
      'import.applied': 'Applied',
      'import.rewritten': 'Rewritten paths',
      'import.backupDir': 'Backup folder',
      'import.warnings': 'Warnings',
      'import.none': '(none)',
      'import.merged': 'Plugin list merge',
      'share.title': 'LAN sharing',
      'share.none': 'Nothing is shared. Use Share on a package to mint a one-shot link.',
      'share.hint': 'The link allows a single download and expires after 60 minutes.',
      'share.remaining': 'downloads left',
      'share.expires': 'expires',
      'share.stop': 'Stop',
      'share.copy': 'Copy link',
      'share.copied': 'Copied',
      'share.copyFailed': 'Copy failed; select the link and copy it manually.',
      'backups.title': 'Backups',
      'backups.none': 'No backups yet. An import backs up the configuration it touches.',
      'backups.restore': 'Restore',
      'backups.restoreConfirm': 'Confirm restore',
      'backups.restoreHint': 'Write these files back into the DSH home; the current versions are saved first.',
      'backups.restored': 'Restored',
      'upload.title': 'Upload a package',
      'upload.send': 'Upload to this machine',
      'upload.hint': 'One .dshpkg file, up to 8 GiB.',
      'upload.progress': 'Uploading',
      'upload.done': 'Upload finished',
      'upload.failed': 'Upload failed',
      'state.running': 'running',
      'state.done': 'done',
      'state.succeeded': 'done',
      'state.failed': 'failed',
      'state.cancelled': 'cancelled',
      'msg.loadFailed': 'Could not read status',
      'msg.actionFailed': 'Action failed',
      'err.hostMissing': 'Host half not loaded: the plugin may be incomplete, or DSH has not been restarted since it was installed.',
      'err.forbidden': 'Refused by the host: open this panel inside the DSH window.',
      'files': 'files',
      'busy': 'another package job is still running; wait for it',
    };

    /* --------------------------------------------------------------- css */

    const css = [
      '.dp-wrap{display:flex;flex-direction:column;gap:16px;padding:4px 2px 24px;',
      'font-family:var(--dsw-font-family);font-size:13px;line-height:1.55;',
      'color:var(--dsw-alias-label-primary);}',
      '.dp-head{display:flex;flex-direction:column;gap:4px;}',
      '.dp-title{font-size:15px;font-weight:600;}',
      '.dp-hint{color:var(--dsw-alias-label-secondary);font-size:12px;}',
      '.dp-card{border:1px solid var(--dsw-alias-border-l1,#d8d8dc);border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,transparent);padding:14px 16px;display:flex;',
      'flex-direction:column;gap:12px;}',
      '.dp-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;}',
      '.dp-card-title{font-size:13px;font-weight:600;}',
      '.dp-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.dp-input{flex:1 1 220px;min-width:160px;height:30px;padding:0 10px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l1,#d8d8dc);background:var(--dsw-alias-bg-base,transparent);',
      'color:inherit;font:inherit;outline:none;}',
      '.dp-input:focus{border-color:var(--dsw-alias-label-tertiary,#8a8a92);}',
      '.dp-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,#d8d8dc);',
      'background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;font:inherit;',
      'height:30px;padding:0 12px;border-radius:8px;cursor:pointer;white-space:nowrap;}',
      '.dp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}',
      '.dp-btn[disabled]{opacity:.45;cursor:default;}',
      '.dp-btn.primary{border-color:transparent;background:var(--dsw-alias-label-primary,#3a3a40);',
      'color:var(--dsw-alias-label-primary-foreground,#fff);}',
      '.dp-btn.danger{color:var(--dsw-alias-state-error-primary,#c0392b);}',
      '.dp-btn.dp-link{display:inline-flex;align-items:center;text-decoration:none;}',
      '.dp-check{display:flex;align-items:center;gap:6px;font-size:12px;',
      'color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;}',
      '.dp-list{display:flex;flex-direction:column;gap:8px;}',
      '.dp-item{display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l1,#e2e2e6);}',
      '.dp-item.sel{border-color:var(--dsw-alias-label-tertiary,#8a8a92);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));}',
      '.dp-item-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;}',
      '.dp-item-name{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dp-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a92);}',
      '.dp-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a92);}',
      '.dp-bar{height:6px;border-radius:4px;background:var(--dsw-alias-border-l1,#e2e2e6);overflow:hidden;}',
      '.dp-bar>i{display:block;height:100%;background:var(--dsw-alias-label-primary,#5a5a62);',
      'transition:width .25s ease;}',
      '.dp-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#c0392b);',
      'white-space:pre-wrap;word-break:break-word;}',
      '.dp-pre{margin:0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));',
      'font-family:var(--dsw-mono-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);',
      'font-size:11.5px;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;}',
      '.dp-tag{font-size:11px;padding:1px 6px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l1,#d8d8dc);color:var(--dsw-alias-label-secondary);}',
      '.dp-spacer{flex:1;}',
      '.dp-notice{font-size:12px;color:var(--dsw-alias-state-success-primary,#2e7d32);}',
      '.dp-warn{font-size:12px;color:var(--dsw-alias-state-error-primary,#c0392b);}',
      '.dp-confirm{border:1px solid var(--dsw-alias-state-warning-primary,#b8860b);border-radius:8px;',
      'padding:10px 12px;display:flex;flex-direction:column;gap:8px;}',
      '.dp-btn.on{border-color:var(--dsw-alias-label-primary,#3a3a40);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));font-weight:600;}',
      '.dp-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px;}',
      '.dp-kv span:nth-child(odd){color:var(--dsw-alias-label-tertiary,#8a8a92);}',
    ].join('');

    if (typeof document !== 'undefined' && document.querySelector('style[data-tag="dsh-portable/panel.css"]') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-portable';
      tag.dataset.tag = 'dsh-portable/panel.css';
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /* -------------------------------------------------------------- api */

    /**
     * Copy text to the clipboard.
     *
     * `navigator.clipboard` is the real API, but it is missing on plain-HTTP
     * origins and can reject while the document is unfocused (the moment a
     * panel is first opened). The textarea fallback covers both cases.
     */
    async function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          let timer = null;
          try {
            await Promise.race([
              navigator.clipboard.writeText(text),
              new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('clipboard write timed out')), 1500);
              }),
            ]);
            return true;
          } finally {
            if (timer !== null) clearTimeout(timer);
          }
        }
      } catch {
        // fall through to the legacy path
      }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        document.body.removeChild(area);
        return ok === true;
      } catch {
        return false;
      }
    }

    // A request that never answers must not leave the panel waiting forever.
    // Export and import return a job immediately and are polled separately, so
    // the only slow calls here are artifact listing and backup restore.
    const CALL_TIMEOUT_MS = 60000;

    async function call(method, path, payload) {
      const init = { method, credentials: 'same-origin', headers: {} };
      if (payload !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(payload);
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller === null ? null : setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
      if (controller !== null) init.signal = controller.signal;
      try {
        const response = await fetch(API_PREFIX + path, init);
        let data = null;
        try {
          data = await response.json();
        } catch {
          data = null;
        }
        if (!response.ok || (data !== null && data.ok === false)) {
          const reason = describeFailure(response, data);
          const failure = new Error(reason);
          failure.code = data ? data.code : undefined;
          throw failure;
        }
        return data;
      } catch (error) {
        if (controller !== null && controller.signal.aborted) {
          throw new Error('timeout after ' + String(CALL_TIMEOUT_MS / 1000) + 's: ' + path);
        }
        throw error;
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = bytes;
      let index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
      }
      return (index === 0 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 1 : 2)) + ' ' + units[index];
    }

    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
      const date = new Date(ms);
      const pad = (value) => String(value).padStart(2, '0');
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    function basename(id) {
      if (typeof id !== 'string') return '';
      const at = id.indexOf(':');
      return at < 0 ? id : id.slice(at + 1);
    }

    /* -------------------------------------------------------- primitives */

    function Card(props) {
      return h('section', { className: 'dp-card' },
        h('div', { className: 'dp-card-head' },
          h('span', { className: 'dp-card-title' }, props.title),
          props.extra ?? null),
        props.children);
    }

    function Btn(props) {
      return h('button', {
        type: 'button',
        className: 'dp-btn' + (props.variant ? ' ' + props.variant : '') + (props.active === true ? ' on' : ''),
        disabled: props.disabled === true,
        'aria-pressed': props.active === true ? 'true' : undefined,
        onClick: props.onClick,
        title: props.title,
      }, props.children);
    }

    function Check(props) {
      return h('label', { className: 'dp-check' },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        props.label);
    }

    function describeProgress(progress) {
      if (progress === null || progress === undefined) return '';
      if (typeof progress.totalFiles === 'number' && progress.totalFiles > 0) {
        return String(progress.files ?? 0) + ' / ' + String(progress.totalFiles) + ' files';
      }
      if (typeof progress.entries === 'number') return String(progress.entries) + ' entries';
      if (typeof progress.files === 'number') return String(progress.files) + ' files';
      return '';
    }

    function JobBar(props) {
      const job = props.job;
      if (job === null || job === undefined) return null;
      const percent = typeof job.progress?.percent === 'number' ? Math.max(0, Math.min(100, job.progress.percent)) : null;
      return h('div', { className: 'dp-row', style: { flexDirection: 'column', alignItems: 'stretch', gap: '6px' } },
        h('div', { className: 'dp-row' },
          h('span', { className: 'dp-tag' }, props.label + ': ' + props.t(job.state)),
          h('span', { className: 'dp-meta' }, describeProgress(job.progress)),
          h('span', { className: 'dp-spacer' }),
          typeof props.onCancel === 'function' && job.state === 'running'
            ? h('button', { className: 'dp-btn', onClick: () => props.onCancel() }, props.t('act.cancel'))
            : null,
          percent === null ? null : h('span', { className: 'dp-meta' }, percent + '%')),
        percent === null ? null : h('div', { className: 'dp-bar' }, h('i', { style: { width: percent + '%' } })),
        job.error ? h('div', { className: 'dp-err' }, job.error.message ?? String(job.error)) : null);
    }

    /* ------------------------------------------------------------ section */

    function PortableSection(props) {
      const t = props.t;
      const [status, setStatus] = useState(null);
      const [artifacts, setArtifacts] = useState([]);
      const [shares, setShares] = useState([]);
      const [backups, setBackups] = useState([]);
      const [error, setError] = useState(null);
      const [busyJob, setBusyJob] = useState(null);
      const [busyLabel, setBusyLabel] = useState('');
      const [selected, setSelected] = useState(null);
      const [plan, setPlan] = useState(null);
      const [report, setReport] = useState(null);
      const [confirming, setConfirming] = useState(null);
      const [copied, setCopied] = useState(null);
      const [notice, setNotice] = useState(null);
      const [uploadPercent, setUploadPercent] = useState(null);
      const [confirmImport, setConfirmImport] = useState(false);
      const [restoreConfirm, setRestoreConfirm] = useState(null);
      const [name, setName] = useState('');
      const [mode, setMode] = useState('merge');
      const [options, setOptions] = useState({
        includeNodeModules: true,
        includeSourceMaps: true,
        includeSessions: false,
        includeRuntimes: false,
        includeCredentials: false,
        includeBackups: false,
      });
      const uploadRef = useRef(null);
      const pollRef = useRef(null);
      // setInterval never waits for the previous tick, and the upload input can
      // fire twice for one selection; both would stack work on the same state.
      const pollBusy = useRef(false);
      const uploadBusy = useRef(false);
      // refresh() is defined before follow(); the ref keeps the late binding
      // without making refresh depend on follow (which would rebuild it every
      // time follow changes and re-run the mount effect).
      const followRef = useRef(null);
      const tRef = useRef(t);
      tRef.current = t;

      const refresh = useCallback(async () => {
        try {
          const [statusResult, artifactResult, shareResult, backupResult] = await Promise.all([
            call('GET', '/status'),
            call('GET', '/artifacts'),
            call('GET', '/share'),
            call('GET', '/backups'),
          ]);
          setStatus(statusResult);
          setArtifacts(artifactResult.artifacts ?? []);
          setShares(shareResult.shares ?? []);
          setBackups(backupResult.backups ?? []);
          // A reload can happen while a job is still running. Adopt it so the
          // progress bar, the cancel button and the busy guards come back
          // instead of leaving a job only the server knows about.
          if (statusResult && statusResult.busyJobId && pollRef.current === null && followRef.current !== null) {
            try {
              const detail = await call('GET', '/jobs/detail?id=' + encodeURIComponent(statusResult.busyJobId));
              followRef.current(detail.job, detail.job.kind === 'export' ? tRef.current('export.running') : tRef.current('import.apply'));
            } catch {
              // The job may have finished between /status and /jobs/detail.
            }
          }
          // A successful refresh updates data; it must not clear a message that
          // another action just set. Whoever started the failing work owns the
          // error and clears it when that work is retried.
        } catch (failure) {
          setError((failure && failure.message) || String(failure));
        }
      }, []);

      useEffect(() => {
        void refresh();
      }, [refresh]);

      // A success notice is a receipt, not a permanent banner: let it fade so
      // the next action's feedback is unambiguous.
      useEffect(() => {
        if (notice === null) return undefined;
        const timer = setTimeout(() => setNotice(null), 4000);
        return () => clearTimeout(timer);
      }, [notice]);

      const stopPolling = useCallback(() => {
        if (pollRef.current !== null) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, []);

      useEffect(() => stopPolling, [stopPolling]);

      /** Follow a job to its end, then hand the settled job to \`onDone\`. */
      const follow = useCallback((job, label, onDone) => {
        stopPolling();
        setBusyJob(job);
        setBusyLabel(label);
        pollRef.current = setInterval(async () => {
          if (pollBusy.current) return;
          pollBusy.current = true;
          try {
            const detail = await call('GET', '/jobs/detail?id=' + encodeURIComponent(job.id));
            const current = detail.job;
            setBusyJob(current);
            if (current.state === 'succeeded' || current.state === 'failed' || current.state === 'cancelled') {
              stopPolling();
              setBusyJob(null);
              if (current.state === 'succeeded' && typeof onDone === 'function') onDone(current.result);
              if (current.state === 'failed') {
                const message = current.error?.message ?? t('state.failed');
                void refresh().finally(() => setError(message));
              } else {
                setError(null);
                void refresh();
              }
            }
          } catch (failure) {
            stopPolling();
            setBusyJob(null);
            setError((failure && failure.message) || String(failure));
          } finally {
            pollBusy.current = false;
          }
        }, 600);
      }, [refresh, stopPolling, t]);
      followRef.current = follow;

      const cancelJob = useCallback(async () => {
        if (busyJob === null) return;
        setError(null);
        try {
          await call('POST', '/jobs/cancel', { id: busyJob.id });
        } catch (failure) {
          setError((failure && failure.message) || String(failure));
        }
      }, [busyJob]);

      const startExport = useCallback(async () => {
        setError(null);
        setNotice(null);
        setPlan(null);
        setReport(null);
        try {
          const created = await call('POST', '/export', {
            name: name.trim() === '' ? undefined : name.trim(),
            ...options,
          });
          setSelected(created.artifactId);
          follow(created.job, t('export.running'), () => setNotice(t('export.done')));
        } catch (failure) {
          setError((failure && failure.message) || String(failure));
        }
      }, [follow, name, options, t]);

      const previewImport = useCallback(async () => {
        if (selected === null) return;
        setError(null);
        setNotice(null);
        setReport(null);
        try {
          const created = await call('POST', '/import/preview', { artifactId: selected });
          follow(created.job, t('import.preview'), (result) => setPlan(result));
        } catch (failure) {
          setError((failure && failure.message) || String(failure));
        }
      }, [follow, selected, t]);

      const runImport = useCallback(async () => {
        if (selected === null) return;
        setError(null);
        setNotice(null);
        setConfirmImport(false);
        try {
          const created = await call('POST', '/import', { artifactId: selected, confirm: true, mode, keepBackups: 5 });
          follow(created.job, t('import.apply'), (result) => { setReport(result); setPlan(null); setNotice(t('restart.hint')); });
        } catch (failure) {
          setError((failure && failure.message) || String(failure));
        }
      }, [follow, mode, selected, t]);

      const shareArtifact = useCallback(async (artifactId) => {
        setError(null);
        setNotice(null);
        try {
          const result = await call('POST', '/share', { artifactId, maxDownloads: 1, ttlMinutes: 60 });
          await refresh();
          const url = result.share && Array.isArray(result.share.urls) ? result.share.urls[0] : null;
          if (url) {
            const ok = await copyText(url);
            setCopied(ok ? url : null);
            if (!ok) setError(t('share.copyFailed'));
          }
        } catch (failure) {
          setError((failure && failure.message) || String(failure));
        }
      }, [refresh, t]);

      const deleteArtifact = useCallback(async (artifactId) => {
        setError(null);
        setNotice(null);
        try {
          await call('POST', '/artifacts/delete', { artifactId });
          setSelected((current) => (current === artifactId ? null : current));
          setPlan(null);
          setReport(null);
          setConfirming(null);
          await refresh();
        } catch (failure) {
          setError((failure && failure.message) || String(failure));
        }
      }, [refresh]);

      const stopShare = useCallback(async (token) => {
        try {
          await call('POST', '/share/remove', { token });
          await refresh();
        } catch (failure) {
          setError((failure && failure.message) || String(failure));
        }
      }, [refresh]);

      const restoreBackup = useCallback(async (stamp) => {
        setError(null);
        setNotice(null);
        try {
          const result = await call('POST', '/backups/restore', { stamp });
          setRestoreConfirm(null);
          const count = Array.isArray(result.restored) ? result.restored.length : 0;
          setNotice(t('backups.restored') + ': ' + count + ' ' + t('files') + ' · ' + t('restart.hint'));
          await refresh();
        } catch (failure) {
          setError((failure && failure.message) || String(failure));
        }
      }, [refresh, t]);

      const uploadFile = useCallback(async (file) => {
        if (file === null || file === undefined) return;
        if (uploadBusy.current) return;
        uploadBusy.current = true;
        setError(null);
        setNotice(null);
        setUploadPercent(0);
        try {
          const target = API_PREFIX + '/upload/' + encodeURIComponent(file.name);
          const data = await new Promise((resolve, reject) => {
            const request = new XMLHttpRequest();
            request.open('PUT', target, true);
            request.withCredentials = true;
            request.upload.onprogress = (event) => {
              if (event.lengthComputable && event.total > 0) {
                setUploadPercent(Math.round((event.loaded / event.total) * 100));
              }
            };
            request.onload = () => {
              let parsed = null;
              try {
                parsed = JSON.parse(request.responseText);
              } catch {
                parsed = null;
              }
              if (request.status < 200 || request.status >= 300 || (parsed !== null && parsed.ok === false)) {
                reject(new Error(describeFailure({ status: request.status }, parsed)));
                return;
              }
              resolve(parsed);
            };
            request.onerror = () => reject(new Error(t('upload.failed')));
            request.onabort = () => reject(new Error(t('upload.failed')));
            request.send(file);
          });
          await refresh();
          if (data && data.artifactId) setSelected(data.artifactId);
          setNotice(t('upload.done'));
        } catch (failure) {
          setError((failure && failure.message) || String(failure));
        } finally {
          uploadBusy.current = false;
          setUploadPercent(null);
        }
      }, [refresh, t]);

      const busy = busyJob !== null;
      const current = artifacts.find((row) => row.id === selected) ?? null;

      /** A readable one-liner for a field that may be a list, a map or a string. */
      const asList = (value) => {
        if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ');
        if (value && typeof value === 'object') return Object.keys(value).join(', ');
        return value === undefined || value === null ? '' : String(value);
      };

      const rewrittenCount = report === null || report.rewrites === null || report.rewrites === undefined
        ? ''
        : asList(report.rewrites.count ?? report.rewrites.files);

      const reportView = report === null ? null : h('div', null,
        h('div', { className: 'dp-card-title', style: { marginBottom: '6px' } }, t('import.done')),
        h('div', { className: 'dp-kv' },
          h('span', null, t('import.applied')),
          h('span', null, asList(report.applied) || t('import.none')),
          h('span', null, t('import.rewritten')),
          h('span', null, rewrittenCount || '0'),
          h('span', null, t('import.backupDir')),
          h('span', null, asList(report.backupDir ?? report.backup) || t('import.none'))),
        Array.isArray(report.warnings) && report.warnings.length > 0
          ? h('div', { className: 'dp-warn' }, t('import.warnings') + ': ' + report.warnings.join('; '))
          : null,
        // package.json merging is invisible otherwise: a plugin this machine
        // installed later stays in the file, and one the package needs but the
        // host never had is only reported here.
        Array.isArray(report.rewrites?.merged) && report.rewrites.merged.length > 0
          ? h('div', { className: 'dp-meta' }, t('import.merged') + ': ' + report.rewrites.merged.map((row) => {
            const kept = Array.isArray(row.kept) && row.kept.length > 0 ? 'kept ' + row.kept.join(', ') : '';
            const missing = Array.isArray(row.missingBundles) && row.missingBundles.length > 0 ? 'missing ' + row.missingBundles.join(', ') : '';
            return [row.path, kept, missing].filter((part) => part !== '').join(' · ');
          }).join(' | '))
          : null);

      return h('div', { className: 'dp-wrap' },
        h('div', { className: 'dp-head' },
          h('div', { className: 'dp-title' }, t('section.label')),
          h('div', { className: 'dp-hint' }, t('section.hint')),
          status === null ? null : h('div', { className: 'dp-meta' },
            'v' + status.version + '  ·  ' + status.profile + '  ·  ' + status.dshHome)),

        error === null ? null : h('div', { className: 'dp-err' }, error),
        notice === null ? null : h('div', { className: 'dp-notice' }, notice),
        busy ? h(JobBar, { job: busyJob, label: busyLabel, t, onCancel: () => void cancelJob() }) : null,

        h(Card, { title: t('export.title') },
          h('div', { className: 'dp-row' },
            h('input', {
              className: 'dp-input',
              value: name,
              placeholder: t('export.namePlaceholder'),
              onChange: (event) => setName(event.target.value),
            }),
            h(Btn, { variant: 'primary', disabled: busy || status === null, onClick: startExport }, t('export.create'))),
          h('div', { className: 'dp-row' },
            h('span', { className: 'dp-meta' }, t('export.options')),
            h(Check, { label: t('opt.nodeModules'), checked: options.includeNodeModules, onChange: (value) => setOptions({ ...options, includeNodeModules: value }) }),
            h(Check, { label: t('opt.sourceMaps'), checked: options.includeSourceMaps, onChange: (value) => setOptions({ ...options, includeSourceMaps: value }) }),
            h(Check, { label: t('opt.sessions'), checked: options.includeSessions, onChange: (value) => setOptions({ ...options, includeSessions: value }) }),
            h(Check, { label: t('opt.runtimes'), checked: options.includeRuntimes, onChange: (value) => setOptions({ ...options, includeRuntimes: value }) }),
            h(Check, { label: t('opt.credentials'), checked: options.includeCredentials, onChange: (value) => setOptions({ ...options, includeCredentials: value }) }),
            h(Check, { label: t('opt.backups'), checked: options.includeBackups, onChange: (value) => setOptions({ ...options, includeBackups: value }) })),
          options.includeCredentials ? h('div', { className: 'dp-warn' }, t('opt.credentialsWarn')) : null),

        h(Card, {
          title: t('packages.title'),
          extra: h(Btn, { disabled: busy, onClick: () => { void refresh(); } }, t('packages.refresh')),
        },
          artifacts.length === 0
            ? h('div', { className: 'dp-empty' }, t('packages.empty'))
            : h('div', { className: 'dp-list' }, artifacts.map((row) => h('div', {
              key: row.id,
              className: 'dp-item' + (row.id === selected ? ' sel' : ''),
            },
              h('div', { className: 'dp-item-main' },
                h('span', { className: 'dp-item-name', title: row.id }, row.name),
                h('span', { className: 'dp-meta' }, formatBytes(row.size) + '  ·  ' + formatTime(row.mtime))),
              h('a', {
                className: 'dp-btn dp-link',
                href: API_PREFIX + '/artifacts/download?artifactId=' + encodeURIComponent(row.id),
                download: row.name,
                title: t('act.downloadHint'),
              }, t('act.download')),
              h(Btn, { onClick: () => { setSelected(row.id); setPlan(null); setReport(null); setConfirmImport(false); }, title: t('act.selectHint') }, t('act.select')),
              h(Btn, { disabled: busy, onClick: () => { void shareArtifact(row.id); } }, t('act.share')),
              confirming === row.id
                ? h(Btn, { variant: 'danger', onClick: () => { void deleteArtifact(row.id); } }, t('act.confirm'))
                : h(Btn, { variant: 'danger', onClick: () => setConfirming(row.id) }, t('act.delete')),
              confirming === row.id ? h(Btn, { onClick: () => setConfirming(null) }, t('act.cancel')) : null)))),

        h(Card, { title: t('upload.title') },
          h('div', { className: 'dp-row' },
            h('input', {
              ref: uploadRef,
              type: 'file',
              accept: '.dshpkg',
              disabled: busy || uploadPercent !== null,
              onChange: (event) => { void uploadFile(event.target.files && event.target.files[0]); event.target.value = ''; },
            }),
            h('span', { className: 'dp-meta' }, t('upload.send'))),
          h('div', { className: 'dp-meta' }, t('upload.hint')),
          uploadPercent === null ? null : h('div', { className: 'dp-notice' }, t('upload.progress') + ' ' + uploadPercent + '%')),

        h(Card, { title: t('import.title') },
          current === null
            ? h('div', { className: 'dp-empty' }, t('import.pick'))
            : h('div', { className: 'dp-row' },
              h('span', { className: 'dp-meta' }, t('import.selected') + ':'),
              h('span', { className: 'dp-item-name' }, current.name),
              h('span', { className: 'dp-tag' }, formatBytes(current.size))),
          h('div', { className: 'dp-row' },
            h('span', { className: 'dp-meta' }, t('import.mode')),
            h(Btn, { active: mode === 'merge', onClick: () => setMode('merge'), title: t('mode.merge') }, t('mode.merge')),
            h(Btn, { active: mode === 'replace', onClick: () => setMode('replace'), title: t('mode.replace') }, t('mode.replace'))),
          h('div', { className: 'dp-row' },
            h(Btn, { disabled: current === null || busy, onClick: previewImport }, t('import.preview')),
            h(Btn, { variant: 'primary', disabled: current === null || busy || confirmImport, onClick: () => setConfirmImport(true) }, t('import.apply'))),
          confirmImport && current !== null
            ? h('div', { className: 'dp-confirm' },
              h('div', { className: 'dp-card-title' }, t('import.confirmTitle')),
              h('div', { className: 'dp-meta' }, t('import.confirmBody') + (mode === 'merge' ? t('mode.merge') : t('mode.replace')) + t('import.confirmBodyTail')),
              h('div', { className: 'dp-warn' }, t('import.confirmHint')),
              h('div', { className: 'dp-row' },
                h(Btn, { variant: 'primary', onClick: () => { void runImport(); } }, t('import.confirm')),
                h(Btn, { onClick: () => setConfirmImport(false) }, t('act.cancel'))))
            : null,
          plan === null ? null : h('div', null,
            h('div', { className: 'dp-card-title', style: { marginBottom: '6px' } }, t('import.plan')),
            h('pre', { className: 'dp-pre' }, JSON.stringify(plan, null, 2))),
          reportView),

        h(Card, { title: t('share.title') },
          shares.length === 0
            ? h('div', { className: 'dp-empty' }, t('share.none'))
            : h('div', null,
              h('div', { className: 'dp-meta', style: { marginBottom: '6px' } }, t('share.hint')),
              h('div', { className: 'dp-list' }, shares.map((row) => h('div', { key: row.token, className: 'dp-item' },
                h('div', { className: 'dp-item-main' },
                  h('span', { className: 'dp-item-name' }, (row.urls && row.urls[0]) || '(no LAN address)'),
                  h('span', { className: 'dp-meta' }, row.displayName + '  ·  ' + t('share.remaining') + ' ' + row.remainingDownloads + '  ·  ' + t('share.expires') + ' ' + formatTime(row.expiresAt))),
                h(Btn, {
                  onClick: () => {
                    const url = row.urls && row.urls[0];
                    if (!url) return;
                    void copyText(url).then((ok) => {
                      setCopied(ok ? url : null);
                      if (!ok) setError(t('share.copyFailed'));
                    });
                  },
                }, copied === (row.urls && row.urls[0]) ? t('share.copied') : t('share.copy')),
                h(Btn, { variant: 'danger', onClick: () => { void stopShare(row.token); } }, t('share.stop'))))))),

        h(Card, { title: t('backups.title') },
          backups.length === 0
            ? h('div', { className: 'dp-empty' }, t('backups.none'))
            : h('div', { className: 'dp-list' }, backups.map((stamp) => h('div', { key: stamp, className: 'dp-item' },
              h('span', { className: 'dp-item-name' }, stamp),
              restoreConfirm === stamp
                ? h('div', { className: 'dp-row' },
                  h(Btn, { variant: 'danger', onClick: () => { void restoreBackup(stamp); } }, t('backups.restoreConfirm')),
                  h(Btn, { onClick: () => setRestoreConfirm(null) }, t('act.cancel')))
                : h(Btn, { title: t('backups.restoreHint'), onClick: () => setRestoreConfirm(stamp) }, t('backups.restore')))))),
      );
    }

    /* -------------------------------------------------------------- apply */

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-portable: dictionaries');
      const t = ctx.locale.bind(NS);
      try {
        const info = typeof ctx.locale.getLocale === 'function' ? ctx.locale.getLocale() : null;
        const active = info && typeof info.active === 'string' ? info.active.toLowerCase() : '';
        activeLocale = active.startsWith('zh') ? 'zh' : active === '' ? activeLocale : 'en';
      } catch {
        // An older host that answers differently keeps the default locale.
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-portable',
        order: 70,
        label: () => t('section.label'),
        locale: NS,
        inject: () => ({ t }),
      }, PortableSection));
    }

    exports.apply = apply;
    exports.inject = inject;

    return module.exports;
  },
});
