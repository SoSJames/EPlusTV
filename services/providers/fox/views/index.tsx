import {FC} from 'hono/jsx';

import {db} from '@/services/database';
import {IProvider} from '@/services/shared-interfaces';
import {TFoxTokens} from '@/services/fox-handler';

import {FoxBody} from './CardBody';

export const FoxSports: FC = async () => {
  const fox = await db.providers.findOneAsync<IProvider<TFoxTokens>>({name: 'foxsports'});
  const enabled = fox?.enabled;
  const tokens = fox?.tokens;
  const channels = fox?.linear_channels || [];
  const only4k = fox?.meta?.only4k;
  const uhd = fox?.meta?.uhd;
  const hide_studio = fox?.meta?.hide_studio;

  return (
    <div>
      <section class="overflow-auto provider-section">
        <div class="grid-container">
          <h4>Fox Sports</h4>
          <fieldset>
            <label>
              Enabled&nbsp;&nbsp;
              <input
                hx-put={`/providers/fox/toggle`}
                hx-trigger="change"
                hx-target="#fox-body"
                name="fox-enabled"
                type="checkbox"
                role="switch"
                checked={enabled ? true : false}
                data-enabled={enabled ? 'true' : 'false'}
              />
            </label>
          </fieldset>
        </div>
        <div class="grid">
          <fieldset>
            <label>
              <input
                hx-put={`/providers/fox/toggle-uhd`}
                hx-trigger="change"
                hx-target="#fox-body"
                name="fox-enabled-uhd"
                type="checkbox"
                role="switch"
                checked={uhd ? true : false}
                data-enabled={uhd ? 'true' : 'false'}
              />
              Enable UHD/HDR events?
            </label>
          </fieldset>
          <fieldset>
            <label>
              <input
                hx-put={`/providers/fox/toggle-4k-only`}
                hx-trigger="change"
                hx-target="#fox-body"
                name="fox-enabled-4k-only"
                type="checkbox"
                role="switch"
                checked={only4k ? true : false}
                data-enabled={only4k ? 'true' : 'false'}
              />
              Only grab 4K events?
            </label>
          </fieldset>
          <fieldset>
            <label>
              <input
                hx-put={`/providers/fox/toggle-studio`}
                hx-trigger="change"
                hx-target="#fox-body"
                name="fox-hide-studio"
                type="checkbox"
                role="switch"
                checked={hide_studio ? true : false}
                data-enabled={hide_studio ? 'true' : 'false'}
              />
              Hide studio shows?
            </label>
          </fieldset>
        </div>
        <div id="fox-body" hx-swap="innerHTML">
          <FoxBody enabled={enabled} tokens={tokens} channels={channels} />
        </div>
      </section>
      <hr />
    </div>
  );
};
