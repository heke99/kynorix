import { MarketExplorer } from '../../components/MarketExplorer';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  return <MarketExplorer initialQuery={q ?? ''} />;
}
