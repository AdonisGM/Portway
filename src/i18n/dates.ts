import { getLang } from '.'

/** Short dates written out by hand (not Intl), so Vietnamese keeps its exact
 *  day-first form: "26/09", "26/09/2026", "09/2026"; English gets "Sep 26",
 *  "Sep 26, 2026", "Sep 2026". Times ("14:05") are the same in both. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const pad2 = (n: number) => String(n).padStart(2, '0')

export const dayMonth = (d: Date) => (getLang() === 'en' ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`)

export const dateOnly = (d: Date) =>
  getLang() === 'en' ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`

export const monthYear = (d: Date) => (getLang() === 'en' ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : `${pad2(d.getMonth() + 1)}/${d.getFullYear()}`)

export const hm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
export const hms = (d: Date) => `${hm(d)}:${pad2(d.getSeconds())}`
