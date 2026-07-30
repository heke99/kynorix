import type { AuthenticatedUser, Balance, FeeQuote, Market, Position } from '@kynorix/contracts';
import * as AuthSession from 'expo-auth-session';
import * as LocalAuthentication from 'expo-local-authentication';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { mobileApi } from './src/api';

WebBrowser.maybeCompleteAuthSession();

type Tab = 'markets' | 'search' | 'portfolio' | 'wallet' | 'account';

const issuer = process.env.EXPO_PUBLIC_OIDC_ISSUER;
const clientId = process.env.EXPO_PUBLIC_OIDC_CLIENT_ID;

export default function App() {
  if (!issuer || !clientId) {
    return <ConfigurationError />;
  }
  return <KynorixApp issuer={issuer} clientId={clientId} />;
}

function KynorixApp({ issuer, clientId }: { issuer: string; clientId: string }) {
  const discovery = AuthSession.useAutoDiscovery(issuer);
  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'kynorix', path: 'auth' });
  const [authRequest, authResponse, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId,
      responseType: AuthSession.ResponseType.Code,
      redirectUri,
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      usePKCE: true,
    },
    discovery,
  );
  const [tab, setTab] = useState<Tab>('markets');
  const [markets, setMarkets] = useState<Market[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<Market>();
  const [user, setUser] = useState<AuthenticatedUser>();
  const [balances, setBalances] = useState<Balance[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [price, setPrice] = useState('50');
  const [quantity, setQuantity] = useState('10');
  const [quote, setQuote] = useState<FeeQuote>();
  const [notice, setNotice] = useState('');

  async function load() {
    setError('');
    try {
      const marketPage = await mobileApi.markets();
      setMarkets(marketPage.items);
      if (await mobileApi.hasSession()) {
        const [nextUser, nextBalances, nextPositions] = await Promise.all([
          mobileApi.me(),
          mobileApi.balances(),
          mobileApi.positions(),
        ]);
        setUser(nextUser);
        setBalances(nextBalances);
        setPositions(nextPositions);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Kynorix is currently unavailable.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (authResponse?.type !== 'success' || !discovery || !authRequest?.codeVerifier) return;
    const code = authResponse.params.code;
    if (!code) {
      setError('The identity provider returned no authorization code.');
      return;
    }
    void AuthSession.exchangeCodeAsync(
      {
        clientId,
        code,
        redirectUri,
        extraParams: { code_verifier: authRequest.codeVerifier },
      },
      discovery,
    )
      .then(async (tokens) => {
        if (!tokens.accessToken) throw new Error('The identity provider returned no access token.');
        if (tokens.refreshToken)
          await mobileApi.saveTokens(tokens.accessToken, tokens.refreshToken);
        else await mobileApi.saveTokens(tokens.accessToken);
        await load();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Login failed.'),
      );
  }, [authRequest?.codeVerifier, authResponse, clientId, discovery, redirectUri]);

  async function unlock() {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Kynorix',
      cancelLabel: 'Cancel',
    });
    if (!result.success) setError('Biometric authentication was not completed.');
  }

  async function reviewOrder() {
    if (!selectedMarket) return;
    if (!user) {
      await promptAsync();
      return;
    }
    try {
      const outcome = selectedMarket.outcomes[0]!;
      setQuote(
        await mobileApi.quoteOrder({
          marketRef: selectedMarket.marketRef,
          outcomeRef: outcome.outcomeRef,
          side: 'buy',
          priceAtoms: price,
          quantity,
          timeInForce: 'GTC',
          postOnly: false,
          maximumSlippageBasisPoints: 100,
        }),
      );
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Quote failed.');
    }
  }

  async function placeOrder() {
    if (!selectedMarket || !quote) return;
    try {
      const outcome = selectedMarket.outcomes[0]!;
      const order = await mobileApi.placeOrder({
        marketRef: selectedMarket.marketRef,
        outcomeRef: outcome.outcomeRef,
        side: 'buy',
        type: 'limit',
        priceAtoms: price,
        quantity,
        timeInForce: 'GTC',
        postOnly: false,
        maximumSlippageBasisPoints: 100,
        quoteRef: quote.quoteRef,
        idempotencyKey: crypto.randomUUID(),
      });
      setNotice(`Order ${order.status.replaceAll('_', ' ')}.`);
      setQuote(undefined);
      await load();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Order failed.');
    }
  }

  const filteredMarkets = useMemo(() => {
    const value = search.trim().toLowerCase();
    return value
      ? markets.filter((market) =>
          `${market.title} ${market.question}`.toLowerCase().includes(value),
        )
      : markets;
  }, [markets, search]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View style={styles.brandMark}>
          <Text style={styles.brandLetter}>K</Text>
        </View>
        <Text style={styles.brand}>kynorix</Text>
        {user ? (
          <Pressable style={styles.balancePill} onPress={() => setTab('wallet')}>
            <Text style={styles.balancePillText}>
              {balances[0] ? formatAtoms(balances[0]!) : 'Wallet'}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            style={styles.loginButton}
            disabled={!authRequest}
            onPress={() => void promptAsync()}
          >
            <Text style={styles.loginText}>Log in</Text>
          </Pressable>
        )}
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
        {error && <Notice value={error} danger />}
        {!loading && selectedMarket ? (
          <MarketDetail
            market={selectedMarket}
            price={price}
            quantity={quantity}
            quote={quote}
            notice={notice}
            onBack={() => {
              setSelectedMarket(undefined);
              setQuote(undefined);
              setNotice('');
            }}
            onPrice={setPrice}
            onQuantity={setQuantity}
            onReview={() => void reviewOrder()}
            onConfirm={() => void placeOrder()}
          />
        ) : (
          <>
            {tab === 'markets' && (
              <MarketList title="Live markets" markets={markets} onSelect={setSelectedMarket} />
            )}
            {tab === 'search' && (
              <>
                <Text style={styles.title}>Search</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Search markets"
                  placeholderTextColor="#61766f"
                  value={search}
                  onChangeText={setSearch}
                />
                <MarketList
                  title="Results"
                  markets={filteredMarkets}
                  onSelect={setSelectedMarket}
                />
              </>
            )}
            {tab === 'portfolio' && (
              <Portfolio
                user={user}
                positions={positions}
                onLogin={() => {
                  void promptAsync();
                }}
              />
            )}
            {tab === 'wallet' && (
              <Wallet
                user={user}
                balances={balances}
                onLogin={() => {
                  void promptAsync();
                }}
              />
            )}
            {tab === 'account' && (
              <Account
                user={user}
                onLogin={() => {
                  void promptAsync();
                }}
                onUnlock={() => {
                  void unlock();
                }}
                onLogout={async () => {
                  await mobileApi.clearTokens();
                  setUser(undefined);
                  setBalances([]);
                  setPositions([]);
                }}
              />
            )}
          </>
        )}
      </ScrollView>
      {!selectedMarket && (
        <View style={styles.tabBar}>
          {(['markets', 'search', 'portfolio', 'wallet', 'account'] as Tab[]).map((value) => (
            <TabButton
              key={value}
              active={tab === value}
              label={value}
              onPress={() => setTab(value)}
            />
          ))}
        </View>
      )}
    </SafeAreaView>
  );
}

function MarketList({
  title,
  markets,
  onSelect,
}: {
  title: string;
  markets: Market[];
  onSelect: (market: Market) => void;
}) {
  return (
    <>
      <Text style={styles.kicker}>KYNO­RIX EVENT EXCHANGE</Text>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>
        Prices, liquidity and status come from the authoritative market service.
      </Text>
      {markets.map((market) => (
        <Pressable
          key={market.marketRef}
          style={styles.marketCard}
          onPress={() => onSelect(market)}
        >
          <View style={styles.cardTop}>
            <Text style={styles.category}>{market.category.toUpperCase()}</Text>
            <Text style={styles.live}>
              {market.status === 'open' && !market.tradingSuspended
                ? '● LIVE'
                : market.status.toUpperCase()}
            </Text>
          </View>
          <Text style={styles.marketTitle}>{market.title}</Text>
          <Text style={styles.question} numberOfLines={3}>
            {market.question}
          </Text>
          <View style={styles.outcomeRow}>
            {market.outcomes.slice(0, 2).map((outcome, index) => (
              <View style={index === 0 ? styles.yes : styles.no} key={outcome.outcomeRef}>
                <Text style={index === 0 ? styles.yesText : styles.noText}>{outcome.label}</Text>
                <Text style={styles.outcomePrice}>{outcome.lastPriceAtoms ?? '—'}</Text>
              </View>
            ))}
          </View>
        </Pressable>
      ))}
      {markets.length === 0 && <Notice value="No markets are currently available." />}
    </>
  );
}

function MarketDetail({
  market,
  price,
  quantity,
  quote,
  notice,
  onBack,
  onPrice,
  onQuantity,
  onReview,
  onConfirm,
}: {
  market: Market;
  price: string;
  quantity: string;
  quote: FeeQuote | undefined;
  notice: string;
  onBack: () => void;
  onPrice: (value: string) => void;
  onQuantity: (value: string) => void;
  onReview: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <Pressable onPress={onBack}>
        <Text style={styles.back}>‹ All markets</Text>
      </Pressable>
      <Text style={styles.kicker}>{market.category.toUpperCase()}</Text>
      <Text style={styles.detailTitle}>{market.title}</Text>
      <Text style={styles.subtitle}>{market.question}</Text>
      <View style={styles.tradeCard}>
        <Text style={styles.sectionTitle}>Buy {market.outcomes[0]?.label}</Text>
        <TextInput
          style={styles.input}
          keyboardType="number-pad"
          value={price}
          onChangeText={(value) => onPrice(value.replace(/\D/g, ''))}
          placeholder="Limit price"
        />
        <TextInput
          style={styles.input}
          keyboardType="number-pad"
          value={quantity}
          onChangeText={(value) => onQuantity(value.replace(/\D/g, ''))}
          placeholder="Quantity"
        />
        {quote && (
          <View>
            <Text style={styles.summary}>
              Fee {quote.feeAtoms} {quote.asset}
            </Text>
            <Text style={styles.summary}>
              Total debit {quote.totalDebitAtoms} {quote.asset}
            </Text>
            <Text style={styles.summary}>
              Possible payout {quote.potentialPayoutAtoms} {quote.asset}
            </Text>
          </View>
        )}
        <Pressable style={styles.primaryButton} onPress={quote ? onConfirm : onReview}>
          <Text style={styles.primaryText}>{quote ? 'Confirm order' : 'Review order'}</Text>
        </Pressable>
        {notice && <Notice value={notice} />}
      </View>
      <View style={styles.rulesBox}>
        <Text style={styles.sectionTitle}>Rules and resolution</Text>
        <Text style={styles.rulesText}>{market.rules}</Text>
        <Text style={styles.source}>{market.resolutionSource}</Text>
      </View>
    </>
  );
}

function Portfolio({
  user,
  positions,
  onLogin,
}: {
  user: AuthenticatedUser | undefined;
  positions: Position[];
  onLogin: () => void;
}) {
  if (!user) return <Protected title="Portfolio" onLogin={onLogin} />;
  return (
    <>
      <Text style={styles.kicker}>POSITIONS</Text>
      <Text style={styles.title}>Portfolio</Text>
      {positions.map((position) => (
        <View style={styles.dataCard} key={`${position.marketRef}:${position.outcomeRef}`}>
          <Text style={styles.dataTitle}>{position.marketTitle}</Text>
          <Text style={styles.dataValue}>
            {position.availableQuantity} {position.outcomeLabel}
          </Text>
          <Text style={styles.dataHint}>Unrealized P&amp;L {position.unrealizedPnlAtoms}</Text>
        </View>
      ))}
      {positions.length === 0 && <Notice value="You do not have any positions yet." />}
    </>
  );
}

function Wallet({
  user,
  balances,
  onLogin,
}: {
  user: AuthenticatedUser | undefined;
  balances: Balance[];
  onLogin: () => void;
}) {
  if (!user) return <Protected title="Wallet" onLogin={onLogin} />;
  return (
    <>
      <Text style={styles.kicker}>FUNDS</Text>
      <Text style={styles.title}>Wallet</Text>
      {balances.map((balance) => (
        <View style={styles.balanceCard} key={balance.asset}>
          <Text style={styles.balanceLabel}>{balance.asset} AVAILABLE</Text>
          <Text style={styles.balance}>{formatAtoms(balance)}</Text>
          <Text style={styles.dataHint}>{balance.lockedAtoms} atomic units locked</Text>
        </View>
      ))}
      <View style={styles.actionRow}>
        <Pressable style={styles.primaryButton}>
          <Text style={styles.primaryText}>Deposit</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton}>
          <Text style={styles.secondaryText}>Withdraw</Text>
        </Pressable>
      </View>
    </>
  );
}

function Account({
  user,
  onLogin,
  onUnlock,
  onLogout,
}: {
  user: AuthenticatedUser | undefined;
  onLogin: () => void;
  onUnlock: () => void;
  onLogout: () => void;
}) {
  if (!user) return <Protected title="Account" onLogin={onLogin} />;
  return (
    <>
      <Text style={styles.kicker}>ACCOUNT</Text>
      <Text style={styles.title}>{user.displayName}</Text>
      <Text style={styles.subtitle}>{user.email}</Text>
      {[
        'Security and MFA',
        'Sessions and devices',
        'Notification preferences',
        'Identity verification',
        'Support',
      ].map((value) => (
        <Pressable style={styles.menuRow} key={value}>
          <Text style={styles.menuText}>{value}</Text>
          <Text style={styles.menuArrow}>›</Text>
        </Pressable>
      ))}
      <Pressable style={styles.secondaryButton} onPress={onUnlock}>
        <Text style={styles.secondaryText}>Test biometric unlock</Text>
      </Pressable>
      <Pressable style={styles.logoutButton} onPress={onLogout}>
        <Text style={styles.logoutText}>Log out</Text>
      </Pressable>
    </>
  );
}

function Protected({ title, onLogin }: { title: string; onLogin: () => void }) {
  return (
    <View style={styles.protected}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>Log in to access private account information.</Text>
      <Pressable style={styles.primaryButton} onPress={onLogin}>
        <Text style={styles.primaryText}>Log in</Text>
      </Pressable>
    </View>
  );
}

function TabButton({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.tabButton} onPress={onPress}>
      <Text style={[styles.tabLabel, active && styles.tabActive]}>
        {label.slice(0, 1).toUpperCase() + label.slice(1)}
      </Text>
    </Pressable>
  );
}

function Notice({ value, danger = false }: { value: string; danger?: boolean }) {
  return (
    <View style={[styles.notice, danger && styles.noticeDanger]}>
      <Text style={danger ? styles.noticeDangerText : styles.noticeText}>{value}</Text>
    </View>
  );
}

function ConfigurationError() {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <Text style={styles.title}>Configuration required</Text>
        <Text style={styles.subtitle}>
          EXPO_PUBLIC_OIDC_ISSUER and EXPO_PUBLIC_OIDC_CLIENT_ID must be set before this application
          can start.
        </Text>
      </View>
    </SafeAreaView>
  );
}

function formatAtoms(balance: Balance): string {
  const value = BigInt(balance.availableAtoms);
  const base = 10n ** BigInt(balance.decimals);
  return `${value / base}.${(value % base).toString().padStart(balance.decimals, '0')} ${balance.asset}`;
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
  loginButton: {
    marginLeft: 'auto',
    backgroundColor: '#62efc1',
    paddingHorizontal: 15,
    paddingVertical: 9,
    borderRadius: 9,
  },
  loginText: { color: '#07100f', fontWeight: '800', fontSize: 11 },
  balancePill: {
    marginLeft: 'auto',
    backgroundColor: '#10231e',
    borderColor: '#245344',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  balancePillText: { color: '#62efc1', fontWeight: '700', fontSize: 10 },
  content: { padding: 20, paddingBottom: 110 },
  loader: { marginTop: 80 },
  kicker: {
    color: '#62efc1',
    fontSize: 9,
    letterSpacing: 1.8,
    fontWeight: '700',
    marginTop: 18,
    marginBottom: 8,
  },
  title: { color: '#f3f8f6', fontWeight: '700', fontSize: 38, letterSpacing: -2, lineHeight: 43 },
  detailTitle: {
    color: '#f3f8f6',
    fontWeight: '700',
    fontSize: 30,
    letterSpacing: -1.2,
    lineHeight: 35,
  },
  subtitle: { color: '#8ea39d', fontSize: 14, lineHeight: 21, marginTop: 10, marginBottom: 20 },
  marketCard: {
    backgroundColor: '#0e1a18',
    borderWidth: 1,
    borderColor: '#20342f',
    borderRadius: 16,
    padding: 17,
    marginBottom: 12,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between' },
  category: { color: '#efc46e', fontSize: 8, letterSpacing: 1 },
  live: { color: '#62efc1', fontSize: 8, letterSpacing: 0.5 },
  marketTitle: { color: '#f1f7f5', fontSize: 18, fontWeight: '700', lineHeight: 23, marginTop: 16 },
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
  back: { color: '#62efc1', fontSize: 12, marginTop: 8 },
  tradeCard: {
    backgroundColor: '#0e1a18',
    borderWidth: 1,
    borderColor: '#285143',
    borderRadius: 17,
    padding: 17,
    marginTop: 8,
  },
  rulesBox: {
    backgroundColor: '#0e1a18',
    borderWidth: 1,
    borderColor: '#20342f',
    borderRadius: 15,
    padding: 17,
    marginTop: 12,
  },
  sectionTitle: { color: '#eff7f4', fontWeight: '700', fontSize: 16, marginBottom: 10 },
  input: {
    color: '#f1f7f5',
    backgroundColor: '#0a1412',
    borderWidth: 1,
    borderColor: '#294038',
    borderRadius: 10,
    padding: 13,
    marginBottom: 10,
  },
  summary: { color: '#8ea39d', fontSize: 11, marginVertical: 3 },
  primaryButton: {
    backgroundColor: '#62efc1',
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  primaryText: { color: '#07100f', fontWeight: '800', fontSize: 11 },
  secondaryButton: {
    borderColor: '#315047',
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  secondaryText: { color: '#dce7e3', fontWeight: '700', fontSize: 11 },
  rulesText: { color: '#849b94', fontSize: 11, lineHeight: 17 },
  source: { color: '#62efc1', fontSize: 9, marginTop: 12 },
  dataCard: {
    backgroundColor: '#0e1a18',
    borderWidth: 1,
    borderColor: '#20342f',
    borderRadius: 14,
    padding: 16,
    marginTop: 10,
  },
  dataTitle: { color: '#eff7f4', fontWeight: '700', fontSize: 13 },
  dataValue: { color: '#62efc1', fontSize: 17, fontWeight: '700', marginTop: 8 },
  dataHint: { color: '#718780', fontSize: 9, marginTop: 5 },
  balanceCard: {
    marginTop: 15,
    backgroundColor: '#10231e',
    borderWidth: 1,
    borderColor: '#245344',
    borderRadius: 18,
    padding: 22,
  },
  balanceLabel: { color: '#80a096', fontSize: 9, letterSpacing: 1.4 },
  balance: { color: '#62efc1', fontWeight: '700', fontSize: 28, marginTop: 12 },
  actionRow: { marginTop: 10 },
  menuRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderBottomColor: '#20342f',
    borderBottomWidth: 1,
    paddingVertical: 17,
  },
  menuText: { color: '#dce7e3', fontSize: 13 },
  menuArrow: { color: '#62efc1', fontSize: 18 },
  logoutButton: { padding: 15, marginTop: 18, alignItems: 'center' },
  logoutText: { color: '#ff8f7b', fontWeight: '700' },
  protected: { marginTop: 40 },
  notice: { backgroundColor: '#133029', borderRadius: 10, padding: 12, marginTop: 12 },
  noticeText: { color: '#baf5e1', fontSize: 10 },
  noticeDanger: { backgroundColor: '#321d1a', borderColor: '#713c34', borderWidth: 1 },
  noticeDangerText: { color: '#ffb1a3', fontSize: 10 },
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
  tabButton: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabLabel: { color: '#61766f', fontSize: 9 },
  tabActive: { color: '#62efc1', fontWeight: '700' },
});
