import { GROUP_NAMES } from '@/data/groups'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useApp } from '@/store/appStore'

/**
 * Settings › Security › "Confirm before connecting to prod", made real.
 *
 * Not held, unlike Delete. Holding is for something that cannot be undone;
 * this is a pause, and a connection you did mean to make should not cost a
 * second of pressing. What it is for is the click that was aimed at the row
 * above — so it says which server, and what the server is for.
 */
export function ConfirmConnectDialog() {
  const pending = useApp((s) => s.pendingConnect)
  const confirmConnect = useApp((s) => s.confirmConnect)
  const cancelConnect = useApp((s) => s.cancelConnect)

  const host = pending?.host

  return (
    <ConfirmDialog
      open={pending !== null}
      title="Connect to production"
      confirmLabel={pending?.where === 'window' ? 'Open window' : 'Connect'}
      confirmVariant="accent"
      onConfirm={confirmConnect}
      onCancel={cancelConnect}
    >
      <span className="font-mono text-fg">
        {host?.user}@{host?.address}:{host?.port}
      </span>{' '}
      is in {host ? GROUP_NAMES[host.group] : ''}.
      <div className="mt-2 text-fg-2">
        Turn this off in Settings › Security if you would rather not be asked.
      </div>
    </ConfirmDialog>
  )
}
