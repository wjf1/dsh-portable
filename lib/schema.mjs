/**
 * dsh-portable — configuration schema.
 *
 * The builder is picked defensively: schemastery ships its builder as the
 * module's default export, so `const { Schema } = await import(...)` yields
 * undefined without raising — and a plugin whose Config is undefined silently
 * loses both its settings form and its whole configuration scope.
 *
 * Every field is volatile: DSH only projects volatile fields into the settings
 * scope, so a non-volatile field never reaches the form.
 */

/** Pick the builder out of whatever shape the schemastery module exposes. */
export function pickSchemaBuilder(namespace) {
  const candidates = [
    namespace?.Schema,
    namespace?.default?.Schema,
    namespace?.default,
    namespace,
  ]
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && typeof candidate.object === 'function') {
      return candidate
    }
  }
  return undefined
}

/**
 * Build the plugin's Config schema, or return undefined when schemastery is not
 * available in this composition (the plugin then runs on defaults).
 */
export function createConfigSchema(schemastery, defaults) {
  const Schema = pickSchemaBuilder(schemastery)
  if (Schema === undefined) return undefined

  return Schema.object({
    includeNodeModules: Schema.boolean().default(defaults.includeNodeModules)
      .description('导出时带上 profiles/<profile>/node_modules。关闭后包很小，但目标机必须联网重装插件。')
      .volatile(),
    includeSessions: Schema.boolean().default(defaults.includeSessions)
      .description('导出会话历史（sessions/）。体积小，但包含你的全部对话记录。')
      .volatile(),
    includeRuntimes: Schema.boolean().default(defaults.includeRuntimes)
      .description('导出 dsh-runtimes/（约数百 MB 的托管运行时）。')
      .volatile(),
    includeCredentials: Schema.boolean().default(defaults.includeCredentials)
      .description('导出 .credentials.yaml（含 API key 等明文凭据）。默认关闭，打开前请确认接收方可信。')
      .volatile(),
    includeSourceMaps: Schema.boolean().default(defaults.includeSourceMaps)
      .description('导出 node_modules 里的 *.map 源码映射。关闭可显著减小体积，不影响运行。')
      .volatile(),
    includeBackups: Schema.boolean().default(defaults.includeBackups)
      .description('导出 cordis.patch.yml.bak-* 之类的历史备份文件。')
      .volatile(),
    exportDir: Schema.string().default(defaults.exportDir)
      .description('导出产物的落盘目录。留空表示 <DSH_HOME>/exports。')
      .volatile(),
    shareEnabled: Schema.boolean().default(defaults.shareEnabled)
      .description('允许生成局域网一次性分享链接。开启后本机会额外监听一个局域网端口。')
      .volatile(),
    shareTtlMinutes: Schema.number().default(defaults.shareTtlMinutes)
      .description('分享链接的有效期（分钟）。')
      .volatile(),
    sharePort: Schema.number().default(defaults.sharePort)
      .description('分享服务端口。0 表示由系统随机分配。')
      .volatile(),
    shareOneShot: Schema.boolean().default(defaults.shareOneShot)
      .description('分享链接在第一次成功下载后立即失效。')
      .volatile(),
    rewritePaths: Schema.boolean().default(defaults.rewritePaths)
      .description('导入时把包内源机的 DSH_HOME 绝对路径改写成目标机路径。')
      .volatile(),
    mergeProfileDeps: Schema.boolean().default(defaults.mergeProfileDeps)
      .description('导入 profile/package.json 时保留目标机独有插件，而不是整体覆盖。')
      .volatile(),
    keepBackups: Schema.number().default(defaults.keepBackups)
      .description('保留最近几份导入前自动备份。')
      .volatile(),
    maxUploadBytes: Schema.number().default(defaults.maxUploadBytes)
      .description('单次上传/下载的体积上限（字节）。')
      .volatile(),
    jobTtlMinutes: Schema.number().default(defaults.jobTtlMinutes)
      .description('导出产物在 exports/ 下的保留时长（分钟）。')
      .volatile(),
  })
}

export const CONFIG_DEFAULTS = {
  includeNodeModules: true,
  includeSessions: false,
  includeRuntimes: false,
  includeCredentials: false,
  includeSourceMaps: false,
  includeBackups: false,
  exportDir: '',
  shareEnabled: false,
  shareTtlMinutes: 30,
  sharePort: 0,
  shareOneShot: true,
  rewritePaths: true,
  mergeProfileDeps: true,
  keepBackups: 5,
  maxUploadBytes: 4 * 1024 * 1024 * 1024,
  jobTtlMinutes: 24 * 60,
}
