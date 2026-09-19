import type { ElementView, RepairEstimate } from '@swarmup/shared'
import { Icon } from './icons'
import { ELEMENT_ICON } from './iconPaths'
import { formatCountdown, severityTier } from '../lib/format'

/**
 * How long until the site stops being a problem. "On site" only says somebody
 * is there; this says when they are done — and when the fix is inherited, that
 * one repair upstream is what closes this site too.
 */
function RepairCountdown({ repair, elementId }: { repair: RepairEstimate; elementId: string }) {
  const inherited = repair.viaElementId !== elementId
  if (repair.totalSeconds === 0) {
    return <span className="site__eta site__eta--done">fixed</span>
  }
  return (
    <span
      className={`site__eta ${inherited ? 'site__eta--inherited' : ''}`}
      title={
        inherited
          ? `Fixed by the repair of ${repair.viaElementId} (${repair.resourceId})`
          : `${formatCountdown(repair.travelSeconds)} travelling + ${formatCountdown(repair.workSeconds)} working`
      }
    >
      fixed in {formatCountdown(repair.totalSeconds)}
      {inherited && ` · via ${repair.viaElementId}`}
    </span>
  )
}

const TYPE_LABEL: Record<string, string> = {
  hospital: 'Hospital',
  datacenter: 'Datacenter',
  substation: 'Substation',
  tower: 'Telecom tower',
  fuel_station: 'Fuel station',
  junction: 'Road junction',
}

const ATTENTION_LABEL: Record<string, string> = {
  unattended: 'Unattended',
  analyzing: 'Analyzing',
  resource_en_route: 'En route',
  resource_assigned: 'On site',
  resolved: 'Resolved',
}

const METRIC_LABEL: Record<string, string> = {
  temperature: 'temp',
  ups_load: 'ups',
  generator_battery: 'batt',
  network_coverage: 'net',
  grid_voltage: 'grid',
  tower_battery: 'tower',
  fuel: 'fuel',
  congestion: 'cong',
}

function formatSensor(metric: string, value: number): string {
  if (metric === 'temperature') return `${Math.round(value)}°C`
  if (
    metric === 'ups_load' ||
    metric === 'generator_battery' ||
    metric === 'network_coverage' ||
    metric === 'tower_battery'
  )
    return `${Math.round(value)}%`
  if (metric === 'congestion') return `${Math.round(value)} min`
  return String(Math.round(value * 10) / 10)
}

interface SitesPanelProps {
  elements: ElementView[]
  criticalityById: Record<string, number>
  selectedElementId: string | null
  onSelectElement: (id: string) => void
  onCollapse: () => void
}

export function SitesPanel({
  elements,
  criticalityById,
  selectedElementId,
  onSelectElement,
  onCollapse,
}: SitesPanelProps) {
  const criticalCount = elements.filter((e) => e.status === 'critical').length

  return (
    <section className="sites glass panel">
      <header className="panel__head">
        <h2>Sites</h2>
        <span className="panel__count">{elements.length}</span>
        {criticalCount > 0 && (
          <span className="badge badge--critical" title="Sites in critical status">
            {criticalCount} critical
          </span>
        )}
        <span className="panel__head-hint">click to focus</span>
        <button
          type="button"
          className="panel__collapse panel__collapse--left"
          onClick={onCollapse}
          title="Hide sites panel"
        >
          <Icon name="chevron" size={13} />
        </button>
      </header>
      <div className="panel__body">
        {elements.map((el) => {
          const tier = severityTier(el.severity)
          const attention = el.attention?.state ?? 'unattended'
          return (
            <button
              key={el.id}
              type="button"
              className={`site site--${el.status} ${el.id === selectedElementId ? 'is-selected' : ''}`}
              onClick={() => onSelectElement(el.id)}
            >
              <div className="site__top">
                <span className="site__icon">
                  <Icon name={ELEMENT_ICON[el.type] ?? 'hospital'} size={15} />
                </span>
                <span className="site__name">
                  <strong>{el.name}</strong>
                  <small>
                    {TYPE_LABEL[el.type] ?? el.type}
                    {criticalityById[el.id] !== undefined && ` · crit ${criticalityById[el.id]}`}
                  </small>
                </span>
                <span className="site__statusdot" title={el.status} />
              </div>

              <div className="site__severity">
                <div className="site__severitybar">
                  <div
                    className={`site__severityfill site__severityfill--${tier}`}
                    style={{ width: `${Math.round(el.severity)}%` }}
                  />
                </div>
                <span className="site__severitynum">{Math.round(el.severity)}</span>
              </div>

              {Object.keys(el.sensors).length > 0 && (
                <div className="site__sensors">
                  {Object.entries(el.sensors)
                    .slice(0, 4)
                    .map(([metric, value]) => (
                      <span key={metric} className="chip">
                        <small>{METRIC_LABEL[metric] ?? metric}</small>
                        <b>{value === undefined ? '--' : formatSensor(metric, value)}</b>
                      </span>
                    ))}
                </div>
              )}

              <div className="site__foot">
                <span className={`att att--${attention}`}>
                  <i aria-hidden="true" />
                  {ATTENTION_LABEL[attention] ?? attention}
                </span>
                {el.attention?.resourceId && (
                  <span className="site__resource">→ {el.attention.resourceId}</span>
                )}
                {el.repair && <RepairCountdown repair={el.repair} elementId={el.id} />}
              </div>
            </button>
          )
        })}
        {elements.length === 0 && <p className="muted">No sites reported.</p>}
      </div>
    </section>
  )
}
