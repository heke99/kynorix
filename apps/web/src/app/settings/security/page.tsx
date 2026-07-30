import { InfoPage } from '../../../components/InfoPage';
import { kynorixApi } from '../../../lib/api';
export default function SecurityPage() {
  return (
    <InfoPage eyebrow="Account protection" title="Security">
      <h2>MFA and passkeys</h2>
      <p>
        Manage TOTP, passkeys, recovery codes and security-method changes through the connected
        identity provider. Withdrawal cooldowns are enforced after material security changes.
      </p>
      <a className="primary-button" href={kynorixApi.accountSecurityUrl()}>
        Manage security methods
      </a>
    </InfoPage>
  );
}
