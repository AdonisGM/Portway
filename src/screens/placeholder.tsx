/** Stand-in for screens that are not built yet. Shows no data. */
export function PlaceholderScreen({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-[23px] font-semibold">{title}</h1>
        <span className="text-[12.5px] text-muted">{subtitle}</span>
      </div>
      <div className="flex h-60 items-center justify-center rounded-xl border border-dashed border-line2 text-[12.5px] text-muted">
        Màn hình này sẽ làm ở bước sau
      </div>
    </div>
  )
}
