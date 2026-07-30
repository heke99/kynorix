'use client';

import type { Order } from '@kynorix/contracts';
import { useCallback, useEffect, useState } from 'react';
import { formatDate, kynorixApi } from '../../lib/api';

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setOrders(await kynorixApi.orders());
    } catch (cause) {
      const value = cause as Error & { status?: number };
      if (value.status === 401) window.location.assign(kynorixApi.loginUrl('/orders'));
      else setError(value.message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="portfolio-page">
      <div className="page-heading">
        <span className="kicker">Order management</span>
        <h1>Orders</h1>
        <p>Review accepted, open, filled, cancelled and expired orders.</p>
      </div>
      {error && <div className="state-card error">{error}</div>}
      <section className="table-card">
        <div className="responsive-table">
          <div className="table-row table-head">
            <span>Market</span>
            <span>Side</span>
            <span>Price</span>
            <span>Remaining</span>
            <span>Status</span>
            <span>Created</span>
          </div>
          {orders.map((order) => (
            <div className="table-row" key={order.orderRef}>
              <span>{order.marketRef}</span>
              <span>
                {order.side} · {order.outcomeRef}
              </span>
              <span>{order.priceAtoms}</span>
              <span>
                {order.remainingQuantity}/{order.quantity}
              </span>
              <span>{order.status.replaceAll('_', ' ')}</span>
              <span>
                {formatDate(order.createdAt)}{' '}
                {(order.status === 'open' || order.status === 'partially_filled') && (
                  <button onClick={() => void kynorixApi.cancelOrder(order.orderRef).then(load)}>
                    Cancel
                  </button>
                )}
              </span>
            </div>
          ))}
          {orders.length === 0 && <div className="empty-row">No orders found.</div>}
        </div>
      </section>
    </div>
  );
}
