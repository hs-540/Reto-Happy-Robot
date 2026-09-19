import { ICON_PATHS } from './iconPaths'

export function Icon({
  name,
  size = 14,
  className,
}: {
  name: string
  size?: number
  className?: string
}) {
  const path = ICON_PATHS[name] ?? ICON_PATHS.system
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      className={className}
      dangerouslySetInnerHTML={{ __html: path }}
    />
  )
}
