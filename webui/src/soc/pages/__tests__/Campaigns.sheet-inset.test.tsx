/**
 * Campaigns detail sheet insets (Round 13 polish, third re-shoot PW4-3): the sheet body
 * starts on the header's 24 px inset (it started 1 px from the edge), and the title icon
 * keeps its size beside a long title that wraps (at 390 px it was squeezed to 0 px).
 * jsdom has no layout: this pins the classes; the insets were measured live (25 px from
 * the sheet's edge, its 1 px border included, at 390, 1440 and 1920).
 *
 * Third re-shoot review: a shared entity's kind reads in the console's words ("IP:", not
 * the "Ip:" `humanizeToken` made of "ip"), and the title sets proportional numerals, so an
 * id's hyphen is not set wide.
 *
 * Round 14 (D29): the list and the sheet title name a campaign by its shared entity and
 * case count ("10.0.0.5 · 3 cases"); the title is plain text with no icon, and the
 * internal id is said in the body.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const { listMock, getMock, forCaseMock, recorrelateMock, apiGetMock, apiPutMock } = vi.hoisted(
  () => ({
    listMock: vi.fn(),
    getMock: vi.fn(),
    forCaseMock: vi.fn(),
    recorrelateMock: vi.fn(),
    apiGetMock: vi.fn(),
    apiPutMock: vi.fn(),
  }),
);

vi.mock('@/soc/pages/Campaigns.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Campaigns.api')>();
  return {
    ...actual,
    campaignsApi: {
      list: listMock,
      get: getMock,
      forCase: forCaseMock,
      recorrelate: recorrelateMock,
    },
  };
});

// The page loads/saves its config through the shared `api.campaign` client
// (getConfig/putConfig → GET/PUT campaigns/config).
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { campaign: { getConfig: apiGetMock, putConfig: apiPutMock }, post: vi.fn() },
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    username: 'tester',
    hasPermission: () => true,
    authEnabled: false,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import { ENTITY_OPTIONS } from '@/soc/rules/constants';
import Campaigns, { CampaignChip } from '../Campaigns';
import { CAMPAIGN_ENTITY_KIND_LABELS, type Campaign } from '../Campaigns.api';

const CAMPAIGN: Campaign = {
  id: 'camp-abc123',
  name: 'Lateral movement on 10.0.0.5',
  status: 'open',
  case_ids: ['case-1', 'case-2', 'case-3'],
  case_count: 3,
  entities: [
    { entity_type: 'ip', value: '10.0.0.5' },
    { entity_type: 'user', value: 'svc-backup' },
  ],
  mitre: ['T1021', 'T1078'],
  severity_rollup: 'high',
  first_seen: '2026-06-29T08:00:00Z',
  last_seen: '2026-06-30T18:00:00Z',
  created_at: '2026-06-29T08:00:00Z',
};

function renderCampaigns(onNavigate = vi.fn()) {
  const utils = render(
    <TooltipProvider>
      <Campaigns onNavigate={onNavigate} />
    </TooltipProvider>,
  );
  return { ...utils, onNavigate };
}

describe('Campaign detail sheet', () => {
  beforeEach(() => {
    listMock.mockReset();
    getMock.mockReset();
    apiGetMock.mockReset();
    listMock.mockResolvedValue({ campaigns: [{ ...CAMPAIGN, name: '', id: 'campaign-4039d3c5ab857211899383250c57b5dc' }], total: 1, enabled: true });
    getMock.mockResolvedValue({ campaign: CAMPAIGN, case_numbers: {} });
    apiGetMock.mockResolvedValue({ config: { enabled: true, cadence: 'daily' } });
  });

  it('insets the body like the header, titles the sheet with the readable label and says the id in the body', async () => {
    renderCampaigns();
    fireEvent.click(await screen.findByText('10.0.0.5 · 3 cases'));
    const sheet = await screen.findByRole('dialog');
    const title = within(sheet).getByRole('heading', { level: 2 });
    // Plain text that wraps, no icon chip beside it.
    expect(title).toHaveTextContent('10.0.0.5 · 3 cases');
    expect(title.querySelector('svg')).toBeNull();
    expect(title).toHaveClass('min-w-0', 'break-words');
    expect(within(sheet).getByTestId('campaign-id')).toHaveTextContent('campaign-4039d3c5ab857211899383250c57b5dc');
    // Every body row and the scrolling sections sit on the header's p-6 inset.
    const badges = within(sheet).getByText('High').closest('div.flex-wrap') as HTMLElement;
    expect(badges).toHaveClass('px-6');
    expect(within(sheet).getByText('First seen').closest('dl')).toHaveClass('px-6');
    const sections = within(sheet).getByRole('heading', { level: 3, name: 'Shared entities' }).closest('section')?.parentElement as HTMLElement;
    expect(sections).toHaveClass('px-6', 'pb-6', 'overflow-y-auto');
  });

  it("names each shared entity's kind in the console's words and sets the title as text", async () => {
    const entities = [
      { entity_type: 'ip', value: '192.0.2.90' },
      { entity_type: 'user', value: 'svc-backup' },
      { entity_type: 'file_hash', value: 'd41d8cd98f00b204e9800998ecf8427e' },
      { entity_type: 'host', value: 'vpn-gw-2' },
    ];
    listMock.mockResolvedValue({
      campaigns: [{ ...CAMPAIGN, name: '', id: 'campaign-4039d3c5ab857211899383250c57b5dc', entities }],
      total: 1,
      enabled: true,
    });
    getMock.mockResolvedValue({ campaign: { ...CAMPAIGN, entities }, case_numbers: {} });
    renderCampaigns();
    fireEvent.click(await screen.findByText('192.0.2.90 · 3 cases'));
    const sheet = await screen.findByRole('dialog');
    const section = within(sheet).getByRole('heading', { level: 3, name: 'Shared entities' }).closest('section') as HTMLElement;
    const kinds = Array.from(section.querySelectorAll('span.text-muted-foreground'), (n) => n.textContent);
    expect(kinds).toEqual(['IP:', 'User:', 'File hash:', 'Host:']);
    expect(section).not.toHaveTextContent('Ip:');
    const title = within(sheet).getByRole('heading', { level: 2 });
    expect(title).toHaveClass('proportional-nums');
  });

  it("uses the rules editor's words for every entity kind (one list, not imported, so no extra chunk)", () => {
    expect(CAMPAIGN_ENTITY_KIND_LABELS).toEqual(Object.fromEntries(ENTITY_OPTIONS.map((o) => [o.value, o.label])));
  });
});
