/*
  Cart auto-add
  Adds a product to the cart once the cart subtotal reaches a threshold, and removes it
  again if the subtotal drops back below. Configured in snippets/cart-drawer.liquid via
  window.cartAutoAdd = { variantId, threshold }.

  The auto-added line carries a hidden `_auto_added` property so it can be told apart
  from the same product added by the customer, and so it never counts toward the threshold.
  If the customer removes the auto-added item while above the threshold, it is not re-added
  until the subtotal drops below the threshold and crosses it again.
*/
(() => {
  const config = window.cartAutoAdd;
  if (!config || !config.variantId || !config.threshold) return;

  const PROPERTY_KEY = '_auto_added';
  const STATE_KEY = `cart-auto-add:${config.variantId}`;
  const CART_ENDPOINT_PATTERN = /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/;

  let running = false;
  let rerun = false;
  let timer;

  const getState = () => {
    try {
      return sessionStorage.getItem(STATE_KEY);
    } catch (e) {
      return null;
    }
  };

  const setState = (value) => {
    try {
      if (value) {
        sessionStorage.setItem(STATE_KEY, value);
      } else {
        sessionStorage.removeItem(STATE_KEY);
      }
    } catch (e) {}
  };

  const isAutoAddedLine = (item) =>
    item.variant_id === config.variantId && item.properties && item.properties[PROPERTY_KEY];

  // Threshold is in shop currency cents; convert when the customer shops in another currency.
  const getThreshold = () => {
    const rate = parseFloat(window.Shopify && window.Shopify.currency && window.Shopify.currency.rate);
    return config.threshold * (rate > 0 ? rate : 1);
  };

  const jsonRequest = (url, body) =>
    originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }).then((response) => {
      if (!response.ok) throw new Error(`${url} responded ${response.status}`);
      return response.json();
    });

  const refreshCartUI = () => {
    if (document.getElementById('main-cart-items')) {
      window.location.reload();
      return Promise.resolve();
    }

    return originalFetch(`${window.routes.cart_url}?sections=cart-drawer,cart-icon-bubble`)
      .then((response) => response.json())
      .then((sections) => {
        const cartDrawer = document.querySelector('cart-drawer');
        const drawerHtml = new DOMParser().parseFromString(sections['cart-drawer'], 'text/html');
        const target = document.getElementById('CartDrawer');
        const source = drawerHtml.getElementById('CartDrawer');
        if (cartDrawer && target && source) {
          target.innerHTML = source.innerHTML;
          cartDrawer.classList.toggle('is-empty', !source.querySelector('.cart-item'));
          const overlay = cartDrawer.querySelector('#CartDrawer-Overlay');
          if (overlay) overlay.addEventListener('click', cartDrawer.close.bind(cartDrawer));
        }

        const bubble = document.getElementById('cart-icon-bubble');
        const bubbleHtml = new DOMParser().parseFromString(sections['cart-icon-bubble'], 'text/html');
        const bubbleSource = bubbleHtml.querySelector('.shopify-section');
        if (bubble && bubbleSource) bubble.innerHTML = bubbleSource.innerHTML;
      });
  };

  const sync = async () => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;

    try {
      const cart = await originalFetch(`${window.routes.cart_url}.js`).then((response) => response.json());
      const autoLines = cart.items.filter(isAutoAddedLine);
      const autoLinesTotal = autoLines.reduce((sum, item) => sum + item.final_line_price, 0);
      const qualifyingSubtotal = cart.items_subtotal_price - autoLinesTotal;
      const qualifies = qualifyingSubtotal >= getThreshold();
      const state = getState();
      let changed = false;

      if (qualifies && autoLines.length === 0) {
        if (state === 'added') {
          // Customer removed the auto-added item themselves; respect that.
          setState('declined');
        } else if (state !== 'declined') {
          await jsonRequest(`${window.routes.cart_add_url}.js`, {
            items: [{ id: config.variantId, quantity: 1, properties: { [PROPERTY_KEY]: 'true' } }],
          });
          setState('added');
          changed = true;
        }
      } else if (!qualifies) {
        for (const item of autoLines) {
          await jsonRequest(`${window.routes.cart_change_url}.js`, { id: item.key, quantity: 0 });
          changed = true;
        }
        setState(null);
      }

      if (changed) {
        await refreshCartUI();
        if (typeof publish === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
          publish(PUB_SUB_EVENTS.cartUpdate, { source: 'cart-auto-add' });
        }
      }
    } catch (e) {
      console.error('cart-auto-add', e);
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        scheduleSync();
      }
    }
  };

  const scheduleSync = () => {
    clearTimeout(timer);
    timer = setTimeout(sync, 300);
  };

  // Watch every cart mutation on the page (theme, Loop bundles and other apps all use fetch).
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (...args) {
    const request = args[0];
    const url = request && String(request.url || request);
    const result = originalFetch(...args);

    if (url && CART_ENDPOINT_PATTERN.test(url)) {
      result.then(scheduleSync, () => {});
    }

    return result;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleSync);
  } else {
    scheduleSync();
  }
})();
