import { MarketExplorer } from '../../../components/MarketExplorer';

export default async function CategoryPage({ params }: { params: Promise<{ category: string }> }) {
  const { category } = await params;
  return <MarketExplorer initialCategory={decodeURIComponent(category)} />;
}
