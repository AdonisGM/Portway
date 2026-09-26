import { Chip } from '../../components/ui/primitives'
import { t } from '../../i18n'
import type { Container } from '../../lib/api'
import { ComposeButtons } from './containers'
import type { DockerCtx } from './docker-screen'
import { projectsOf, projectStatus } from './format'

/** One card per compose project, found from its containers' labels. */
export function ComposeView({ ctx, containers }: { ctx: DockerCtx; containers: Container[] }) {
  const projects = projectsOf(containers)
  if (!projects.length) {
    return (
      <div className="rounded-xl border border-line bg-surface p-8 text-center text-muted">
        {t('Không có project compose nào. Container chạy bằng docker compose mới hiện ở đây.')}
      </div>
    )
  }
  return (
    // As tall as its cards; scrolls inside once they outgrow the window.
    <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <div className="min-h-0 overflow-auto overscroll-contain">
        {projects.map((p) => {
          const st = projectStatus(p.containers)
          return (
            <div key={p.name} className="flex flex-wrap items-center gap-3 border-t border-line px-3.5 py-3 first:border-t-0">
              <div className="flex min-w-[220px] flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{p.name}</span>
                  <Chip tone={st.tone}>{st.label}</Chip>
                </span>
                {p.files.length ? (
                  <span className="font-mono text-[11px] [overflow-wrap:anywhere] text-muted select-text">{p.files.join(', ')}</span>
                ) : (
                  <span className="text-[11px] text-muted">{t('Không rõ file compose (container không có nhãn config_files)')}</span>
                )}
                <span className="text-[11.5px] text-ink2">{p.containers.map((c) => c.name).join(', ')}</span>
              </div>
              {p.files.length > 0 && <ComposeButtons ctx={ctx} project={p} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
