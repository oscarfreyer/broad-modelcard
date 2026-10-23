import Icon from '../../design/Icon.jsx';
import { SelectField } from './FormFields.jsx';

/**
 * Local results (contract v1.13, §26) belong to a card and a published local
 * population: the population picker of that page, or the way to publish one
 * first.
 *
 * @param {object} props
 * @param {{ id: string, name: string }[]} props.populations the live local populations
 * @param {string|null} props.value the chosen population's id
 * @param {(id: string) => void} props.onChange
 */
export default function LocalPopulationCard({ populations, value, onChange }) {
  return (
    <section className="admin-card local-population-card" aria-label="Local population">
      {populations.length ? (
        <SelectField
          label="Local population"
          value={value ?? ''}
          options={populations.map((entry) => ({ value: entry.id, label: `${entry.name} (${entry.id})` }))}
          hint="Readers who choose this population see these results; everyone else sees the public ones."
          onChange={onChange}
        />
      ) : (
        <p className="admin-card-text">
          <Icon name="info" size={18} className="inline-icon" /> Publish a local population under Local populations first.
        </p>
      )}
    </section>
  );
}
