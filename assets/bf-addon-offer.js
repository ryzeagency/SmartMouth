/*
  Black Friday $10 add-on offer.
  Configured and rendered in snippets/bf-addon-offer.liquid (window.bfAddonOffer).

  - After any cart change, if the cart has at least `minRinses` one-time-purchase
    items from the rinse collection and no add-on yet, open the popup. It opens
    at most once per browser session: after "Add" or "No thanks" it stays closed.
  - Any [data-bf-addon-add] button (popup or cart drawer card) adds the add-on,
    refreshes the cart drawer and opens it.
*/
(() => {
  const config = window.bfAddonOffer;
  const modal = document.getElementById('BfAddonModal');
  if (!config || !config.variantId || !modal) return;

  const SEEN_KEY = `bf-addon-offer:${config.variantId}`;
  const CART_ENDPOINT_PATTERN = /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/;
  const rinseIds = new Set(config.rinseProductIds || []);
  const originalFetch = window.fetch.bind(window);

  let timer;
  let lastFocused = null;

  const isLive = () => {
    const now = Date.now();
    return now >= config.startsAt && now < config.endsAt;
  };

  const wasSeen = () => {
    try {
      return sessionStorage.getItem(SEEN_KEY) === '1';
    } catch (e) {
      return false;
    }
  };

  const markSeen = () => {
    try {
      sessionStorage.setItem(SEEN_KEY, '1');
    } catch (e) {}
  };

  const qualifies = (cart) => {
    let rinses = 0;
    let hasAddon = false;
    cart.items.forEach((item) => {
      if (item.variant_id === config.variantId || item.product_id === config.productId) {
        hasAddon = true;
      } else if (rinseIds.has(item.product_id) && !item.selling_plan_allocation) {
        rinses += item.quantity;
      }
    });
    return !hasAddon && rinses >= config.minRinses;
  };

  const cartDrawer = () => document.querySelector('cart-drawer');
  const drawerIsOpen = () => {
    const drawer = cartDrawer();
    return Boolean(drawer && drawer.classList.contains('active'));
  };

  // Hand focus back to the cart drawer if it is open underneath, else to where it was.
  const restoreFocus = () => {
    if (typeof trapFocus === 'function' && drawerIsOpen()) {
      const inner = cartDrawer().querySelector('.drawer__inner');
      if (inner) trapFocus(inner, inner.querySelector('.drawer__close') || inner);
      return;
    }
    if (typeof removeTrapFocus === 'function') removeTrapFocus(lastFocused);
    else if (lastFocused && lastFocused.focus) lastFocused.focus();
  };

  const openModal = () => {
    if (!modal.hidden) return;
    lastFocused = document.activeElement;
    modal.hidden = false;
    document.body.classList.add('overflow-hidden');
    const addButton = modal.querySelector('[data-bf-addon-add]');
    if (typeof trapFocus === 'function') trapFocus(modal, addButton);
    else if (addButton) addButton.focus();
    markSeen();
  };

  const closeModal = () => {
    if (modal.hidden) return;
    modal.hidden = true;
    if (!drawerIsOpen()) document.body.classList.remove('overflow-hidden');
    restoreFocus();
  };

  const check = async () => {
    if (!isLive() || wasSeen() || !modal.hidden) return;
    try {
      const cart = await originalFetch(`${window.routes.cart_url}.js`).then((response) => response.json());
      if (qualifies(cart) && !wasSeen()) openModal();
    } catch (e) {
      console.error('bf-addon-offer', e);
    }
  };

  const scheduleCheck = () => {
    clearTimeout(timer);
    timer = setTimeout(check, 400);
  };

  // Re-render the cart drawer and cart count, the same way the theme does after an add.
  const refreshCartUI = () => {
    if (document.getElementById('main-cart-items')) {
      window.location.reload();
      return Promise.resolve();
    }

    return originalFetch(`${window.routes.cart_url}?sections=cart-drawer,cart-icon-bubble`)
      .then((response) => response.json())
      .then((sections) => {
        const drawer = cartDrawer();
        const target = document.getElementById('CartDrawer');
        const source = new DOMParser().parseFromString(sections['cart-drawer'], 'text/html').getElementById('CartDrawer');
        if (drawer && target && source) {
          target.innerHTML = source.innerHTML;
          drawer.classList.toggle('is-empty', !source.querySelector('.cart-item'));
          const overlay = drawer.querySelector('#CartDrawer-Overlay');
          if (overlay) overlay.addEventListener('click', drawer.close.bind(drawer));
        }

        const bubble = document.getElementById('cart-icon-bubble');
        const bubbleSource = new DOMParser()
          .parseFromString(sections['cart-icon-bubble'], 'text/html')
          .querySelector('.shopify-section');
        if (bubble && bubbleSource) bubble.innerHTML = bubbleSource.innerHTML;
      });
  };

  const addAddon = async (button) => {
    const container = button.closest('.bf-addon-modal__panel, .cart-drawer__bf-addon') || button.parentElement;
    const error = container && container.querySelector('.bf-addon__error');
    const label = button.textContent;

    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Adding…';
    if (error) error.hidden = true;

    try {
      const response = await originalFetch(`${window.routes.cart_add_url}.js`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ items: [{ id: config.variantId, quantity: 1 }] }),
      });
      if (!response.ok) throw new Error(`cart/add responded ${response.status}`);

      markSeen();
      await refreshCartUI();
      if (typeof publish === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
        publish(PUB_SUB_EVENTS.cartUpdate, { source: 'bf-addon-offer' });
      }

      const wasInModal = !modal.hidden && modal.contains(button);
      closeModal();
      const drawer = cartDrawer();
      if (wasInModal && drawer && !drawerIsOpen() && typeof drawer.open === 'function') drawer.open();
    } catch (e) {
      console.error('bf-addon-offer', e);
      if (error) {
        error.textContent = 'Sorry, we couldn’t add it. Please try again.';
        error.hidden = false;
      }
    } finally {
      // The drawer card is replaced on refresh; this only matters for the popup or a failed add.
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = label;
    }
  };

  document.addEventListener('click', (event) => {
    const addButton = event.target.closest('[data-bf-addon-add]');
    if (addButton) {
      event.preventDefault();
      addAddon(addButton);
      return;
    }
    if (event.target.closest('[data-bf-addon-close]') && modal.contains(event.target)) {
      closeModal();
    }
  });

  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeModal();
    }
  });

  // Watch cart changes from the theme, Loop bundles and other apps (they all use fetch).
  window.fetch = function (...args) {
    const request = args[0];
    const url = request && String(request.url || request);
    const result = originalFetch(...args);
    if (url && CART_ENDPOINT_PATTERN.test(url)) result.then(scheduleCheck, () => {});
    return result;
  };
})();
