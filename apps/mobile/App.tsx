import type { Balance, Market } from '@kynorix/contracts';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { mobileApi } from './src/api';

type Tab = 'markets' | 'portfolio' | 'security';

export default function App() {
  const [tab, setTab] = useState<Tab>('markets');
  const [markets, setMarkets] = useState<Market[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<Market>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [orderNotice, setOrderNotice] = useState('');
  const [orderBusy, setOrderBusy] = useState(false);

  async function load() {
    setError('');
    try {
      const [nextMarkets, nextBalances] = await Promise.all([
        mobileApi.markets(),
        mobileApi.balances(),
      ]);
      setMarkets(nextMarkets);
      setBalances(nextBalances);
    } catch {
      setError('API:t går inte att nå. Kontrollera EXPO_PUBLIC_API_URL.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const mode = mobileApi.mode();

  async function buy(outcomeIndex: number, priceAtoms: string) {
    if (!selectedMarket) return;
    setOrderBusy(true);
    setOrderNotice('');
    try {
      const order = await mobileApi.placeOrder({
        marketRef: selectedMarket.marketRef,
        outcomeRef: selectedMarket.outcomes[outcomeIndex]!.outcomeRef,
        side: 'buy',
        type: 'limit',
        priceAtoms,
        quantity: '10',
        timeInForce: 'GTC',
        postOnly: false,
        idempotencyKey: `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      setOrderNotice(`Order ${order.status} · ${order.orderRef.slice(0, 14)}…`);
      await load();
    } catch (cause) {
      setOrderNotice(cause instanceof Error ? cause.message : 'Ordern kunde inte skickas');
    } finally {
      setOrderBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View style={styles.brandMark}>
          <Text style={styles.brandLetter}>K</Text>
        </View>
        <Text style={styles.brand}>kynorix</Text>
        <View style={styles.sandboxPill}>
          <View style={styles.dot} />
          <Text style={styles.sandboxText}>SANDBOX</Text>
        </View>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor="#62efc1"
            onRefresh={() => {
              setRefreshing(true);
              void load();
            }}
          />
        }
      >
        {loading && <ActivityIndicator color="#62efc1" style={styles.loader} />}
        {error && (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
        {!loading && tab === 'markets' && selectedMarket && (
          <>
            <Pressable style={styles.backButton} onPress={() => setSelectedMarket(undefined)}>
              <Text style={styles.backText}>‹ Alla marknader</Text>
            </Pressable>
            <Text style={styles.kicker}>{selectedMarket.category.toUpperCase()}</Text>
            <Text style={styles.detailTitle}>{selectedMarket.title}</Text>
            <Text style={styles.subtitle}>{selectedMarket.question}</Text>
            <View style={styles.tradeCard}>
              <Text style={styles.tradeHeading}>Handla virtuellt</Text>
              <Text style={styles.tradeHint}>10 kontrakt · limitorder · GTC</Text>
              <View style={styles.tradeButtons}>
                <Pressable
                  disabled={orderBusy}
                  style={styles.buyYes}
                  onPress={() => void buy(0, '55')}
                >
                  <Text style={styles.buyYesLabel}>KÖP JA</Text>
                  <Text style={styles.buyPrice}>55%</Text>
                </Pressable>
                <Pressable
                  disabled={orderBusy}
                  style={styles.buyNo}
                  onPress={() => void buy(1, '50')}
                >
                  <Text style={styles.buyNoLabel}>KÖP NEJ</Text>
                  <Text style={styles.buyPrice}>50%</Text>
                </Pressable>
              </View>
              <Text style={styles.tradeSummary}>
                Maximal utbetalning 10,00 VSEK · avgift bokförs separat
              </Text>
              {!!orderNotice && <Text style={styles.orderNotice}>{orderNotice}</Text>}
            </View>
            <View style={styles.rulesBox}>
              <Text style={styles.rulesTitle}>Resolution och regler</Text>
              <Text style={styles.rulesText}>{selectedMarket.rules}</Text>
              <Text style={styles.rulesSource}>{selectedMarket.resolutionSource}</Text>
            </View>
          </>
        )}
        {!loading && tab === 'markets' && !selectedMarket && (
          <>
            <Text style={styles.kicker}>KOLLEKTIV INTELLIGENS</Text>
            <Text style={styles.title}>Vad händer härnäst?</Text>
            <Text style={styles.subtitle}>
              Virtuella eventmarknader med tydliga regler och granskningsbar resolution.
            </Text>
            <View style={styles.securityStrip}>
              <Text style={styles.securityIcon}>✓</Text>
              <View>
                <Text style={styles.securityTitle}>Säker produktpolicy</Text>
                <Text style={styles.securityText}>
                  Real-money och binära optioner är avstängda.
                </Text>
              </View>
            </View>
            <Text style={styles.sectionTitle}>Öppna marknader</Text>
            {markets.map((market) => (
              <Pressable
                key={market.marketRef}
                style={({ pressed }) => [styles.marketCard, pressed && styles.pressed]}
                onPress={() => {
                  setSelectedMarket(market);
                  setOrderNotice('');
                }}
              >
                <View style={styles.cardTop}>
                  <Text style={styles.category}>{market.category.toUpperCase()}</Text>
                  <Text style={styles.open}>● ÖPPEN</Text>
                </View>
                <Text style={styles.marketTitle}>{market.title}</Text>
                <Text style={styles.question} numberOfLines={3}>
                  {market.question}
                </Text>
                <View style={styles.outcomeRow}>
                  <View style={styles.yes}>
                    <Text style={styles.yesText}>JA</Text>
                    <Text style={styles.outcomePrice}>55%</Text>
                  </View>
                  <View style={styles.no}>
                    <Text style={styles.noText}>NEJ</Text>
                    <Text style={styles.outcomePrice}>50%</Text>
                  </View>
                </View>
              </Pressable>
            ))}
          </>
        )}
        {!loading && tab === 'portfolio' && (
          <>
            <Text style={styles.kicker}>DEMOIDENTITET · ALEX</Text>
            <Text style={styles.title}>Portfölj</Text>
            <View style={styles.balanceCard}>
              <Text style={styles.balanceLabel}>TILLGÄNGLIGT</Text>
              <Text style={styles.balance}>{formatAtoms(balances[0]?.availableAtoms ?? '0')}</Text>
              <Text style={styles.balanceSub}>Virtuellt saldo · inget kontantvärde</Text>
            </View>
            <View style={styles.statRow}>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>LÅST</Text>
                <Text style={styles.statValue}>{formatAtoms(balances[0]?.lockedAtoms ?? '0')}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>MARKNADER</Text>
                <Text style={styles.statValue}>{markets.length}</Text>
              </View>
            </View>
          </>
        )}
        {!loading && tab === 'security' && (
          <>
            <Text style={styles.kicker}>ENHET OCH POLICY</Text>
            <Text style={styles.title}>Säkerhetscenter</Text>
            {[
              ['Produktläge', mode.mode ?? 'sandbox', true],
              ['Real-money', mode.realMoney ? 'Aktivt' : 'Spärrat', !mode.realMoney],
              ['Binära optioner', 'Spärrade', true],
              ['Lokala tokens', 'SecureStore', true],
              ['Biometrisk step-up', 'Integrationsgräns klar', true],
            ].map(([name, value, healthy]) => (
              <View style={styles.securityRow} key={String(name)}>
                <View style={[styles.securityCheck, healthy ? styles.checkGood : styles.checkBad]}>
                  <Text>{healthy ? '✓' : '!'}</Text>
                </View>
                <View>
                  <Text style={styles.securityName}>{name}</Text>
                  <Text style={styles.securityValue}>{value}</Text>
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>
      <View style={styles.tabBar}>
        <TabButton
          active={tab === 'markets'}
          label="Marknader"
          icon="◇"
          onPress={() => {
            setTab('markets');
            setSelectedMarket(undefined);
          }}
        />
        <TabButton
          active={tab === 'portfolio'}
          label="Portfölj"
          icon="◫"
          onPress={() => setTab('portfolio')}
        />
        <TabButton
          active={tab === 'security'}
          label="Säkerhet"
          icon="◎"
          onPress={() => setTab('security')}
        />
      </View>
    </SafeAreaView>
  );
}

function TabButton({
  active,
  label,
  icon,
  onPress,
}: {
  active: boolean;
  label: string;
  icon: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.tabButton} onPress={onPress}>
      <Text style={[styles.tabIcon, active && styles.tabActive]}>{icon}</Text>
      <Text style={[styles.tabLabel, active && styles.tabActive]}>{label}</Text>
    </Pressable>
  );
}

function formatAtoms(value: string): string {
  return `${(Number(value) / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} VSEK`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#07100f' },
  header: {
    height: 62,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#1d302b',
  },
  brandMark: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: '#62efc1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandLetter: { color: '#07100f', fontWeight: '900', fontSize: 16 },
  brand: { color: '#f1f8f5', fontWeight: '800', fontSize: 20, letterSpacing: -1, marginLeft: 9 },
  sandboxPill: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#294038',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 9,
  },
  dot: { width: 5, height: 5, backgroundColor: '#62efc1', borderRadius: 3 },
  sandboxText: { color: '#8ea39d', fontSize: 8, letterSpacing: 1 },
  content: { padding: 20, paddingBottom: 110 },
  loader: { marginTop: 80 },
  backButton: { marginTop: 12, marginBottom: 7 },
  backText: { color: '#62efc1', fontSize: 12 },
  kicker: {
    color: '#62efc1',
    fontSize: 9,
    letterSpacing: 1.8,
    fontWeight: '700',
    marginTop: 18,
    marginBottom: 8,
  },
  title: { color: '#f3f8f6', fontWeight: '700', fontSize: 40, letterSpacing: -2, lineHeight: 43 },
  detailTitle: {
    color: '#f3f8f6',
    fontWeight: '700',
    fontSize: 32,
    letterSpacing: -1.4,
    lineHeight: 36,
  },
  subtitle: { color: '#8ea39d', fontSize: 14, lineHeight: 21, marginTop: 13, marginBottom: 20 },
  securityStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#10231e',
    borderColor: '#204d40',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 27,
  },
  securityIcon: {
    width: 28,
    height: 28,
    textAlign: 'center',
    lineHeight: 28,
    backgroundColor: '#173c31',
    color: '#62efc1',
    borderRadius: 8,
    overflow: 'hidden',
  },
  securityTitle: { color: '#dfeae6', fontWeight: '700', fontSize: 11 },
  securityText: { color: '#80958e', fontSize: 9, marginTop: 3 },
  sectionTitle: { color: '#f3f8f6', fontWeight: '700', fontSize: 18, marginBottom: 12 },
  marketCard: {
    backgroundColor: '#0e1a18',
    borderWidth: 1,
    borderColor: '#20342f',
    borderRadius: 16,
    padding: 17,
    marginBottom: 12,
  },
  tradeCard: {
    backgroundColor: '#0e1a18',
    borderWidth: 1,
    borderColor: '#285143',
    borderRadius: 17,
    padding: 17,
    marginTop: 6,
  },
  tradeHeading: { color: '#eff7f4', fontWeight: '700', fontSize: 16 },
  tradeHint: { color: '#748b84', fontSize: 9, marginTop: 4 },
  tradeButtons: { flexDirection: 'row', gap: 9, marginTop: 16 },
  buyYes: {
    flex: 1,
    backgroundColor: '#173d32',
    borderRadius: 11,
    padding: 14,
    alignItems: 'center',
  },
  buyNo: {
    flex: 1,
    backgroundColor: '#3a211d',
    borderRadius: 11,
    padding: 14,
    alignItems: 'center',
  },
  buyYesLabel: { color: '#62efc1', fontSize: 10, fontWeight: '800' },
  buyNoLabel: { color: '#ff8f7b', fontSize: 10, fontWeight: '800' },
  buyPrice: { color: '#f3f8f6', fontSize: 19, fontWeight: '700', marginTop: 5 },
  tradeSummary: { color: '#758b84', fontSize: 8, marginTop: 12, textAlign: 'center' },
  orderNotice: {
    color: '#baf5e1',
    backgroundColor: '#133029',
    padding: 10,
    borderRadius: 8,
    overflow: 'hidden',
    marginTop: 10,
    fontSize: 9,
  },
  rulesBox: {
    backgroundColor: '#0e1a18',
    borderWidth: 1,
    borderColor: '#20342f',
    borderRadius: 15,
    padding: 17,
    marginTop: 12,
  },
  rulesTitle: { color: '#eff7f4', fontWeight: '700', fontSize: 13 },
  rulesText: { color: '#849b94', fontSize: 10, lineHeight: 16, marginTop: 9 },
  rulesSource: { color: '#62efc1', fontSize: 8, marginTop: 12 },
  pressed: { opacity: 0.7 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  category: {
    color: '#efc46e',
    fontSize: 8,
    letterSpacing: 1,
    backgroundColor: '#262217',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    overflow: 'hidden',
  },
  open: { color: '#62efc1', fontSize: 8, letterSpacing: 0.5 },
  marketTitle: {
    color: '#f1f7f5',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.5,
    lineHeight: 23,
    marginTop: 16,
  },
  question: { color: '#849b94', fontSize: 11, lineHeight: 16, marginTop: 7 },
  outcomeRow: { flexDirection: 'row', gap: 8, marginTop: 16 },
  yes: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#122d26',
    borderRadius: 9,
    padding: 10,
  },
  no: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#2c1c1a',
    borderRadius: 9,
    padding: 10,
  },
  yesText: { color: '#62efc1', fontWeight: '700', fontSize: 10 },
  noText: { color: '#ff8f7b', fontWeight: '700', fontSize: 10 },
  outcomePrice: { color: '#f1f7f5', fontWeight: '700', fontSize: 11 },
  balanceCard: {
    marginTop: 24,
    backgroundColor: '#10231e',
    borderWidth: 1,
    borderColor: '#245344',
    borderRadius: 18,
    padding: 22,
  },
  balanceLabel: { color: '#80a096', fontSize: 9, letterSpacing: 1.4 },
  balance: { color: '#62efc1', fontWeight: '700', fontSize: 31, letterSpacing: -1, marginTop: 12 },
  balanceSub: { color: '#718780', fontSize: 9, marginTop: 6 },
  statRow: { flexDirection: 'row', gap: 11, marginTop: 11 },
  stat: {
    flex: 1,
    backgroundColor: '#0e1a18',
    borderWidth: 1,
    borderColor: '#20342f',
    borderRadius: 14,
    padding: 16,
  },
  statLabel: { color: '#718780', fontSize: 8, letterSpacing: 1 },
  statValue: { color: '#edf5f2', fontWeight: '700', fontSize: 17, marginTop: 10 },
  securityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1c2d29',
    paddingVertical: 15,
  },
  securityCheck: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkGood: { backgroundColor: '#15392f' },
  checkBad: { backgroundColor: '#38201d' },
  securityName: { color: '#dce7e3', fontWeight: '600', fontSize: 12 },
  securityValue: { color: '#7d928c', fontSize: 10, marginTop: 3 },
  errorCard: {
    backgroundColor: '#321d1a',
    borderColor: '#713c34',
    borderWidth: 1,
    padding: 14,
    borderRadius: 12,
  },
  errorText: { color: '#ffb1a3', fontSize: 11 },
  tabBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 76,
    backgroundColor: '#0a1311',
    borderTopWidth: 1,
    borderTopColor: '#1d302b',
    flexDirection: 'row',
    paddingBottom: 8,
  },
  tabButton: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  tabIcon: { color: '#61766f', fontSize: 19 },
  tabLabel: { color: '#61766f', fontSize: 9 },
  tabActive: { color: '#62efc1' },
});
