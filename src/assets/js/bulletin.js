/* One set of sections: two reading columns on desktop, editorial order on mobile. */
function initializeBulletin(document, window) {
  const container = document.querySelector('.bulletin-sections');
  if (container) {
    const ordered = Array.from(container.children);
    const sideIds = new Set(['service', 'scripture', 'thisweek']);
    const desktop = window.matchMedia('(min-width: 1100px)');
    function arrange() {
      const activeElement = document.activeElement;
      // Reuse nodes so links, image loading, and focus are preserved across resizes.
      container.replaceChildren();
      container.classList.toggle('has-columns', desktop.matches);
      container.classList.remove('only-main', 'only-sidebar');
      if (desktop.matches) {
        const main = document.createElement('div');
        const sidebar = document.createElement('div');
        main.className = 'bulletin-main';
        sidebar.className = 'bulletin-sidebar';
        ordered.filter(section => section.id).forEach(section => {
          (sideIds.has(section.id) ? sidebar : main).appendChild(section);
        });
        if (main.children.length) container.appendChild(main);
        if (sidebar.children.length) container.appendChild(sidebar);
        container.classList.toggle('only-sidebar', !main.children.length);
        container.classList.toggle('only-main', !sidebar.children.length);
        ordered.filter(section => !section.id).forEach(section => container.appendChild(section));
      } else {
        ordered.forEach(section => container.appendChild(section));
      }
      if (activeElement && activeElement !== document.body && container.contains(activeElement)) {
        activeElement.focus({ preventScroll: true });
      }
    }
    arrange();
    desktop.addEventListener('change', arrange);
  }

  document.querySelectorAll('.item-image img').forEach(img => {
    const fail = () => img.closest('.item-image').classList.add('is-unavailable');
    img.addEventListener('error', fail, { once: true });
    if (img.complete && !img.naturalWidth) fail();
  });

  document.querySelectorAll('.site-header__nav a').forEach(link => {
    if (new URL(link.href).pathname === window.location.pathname) link.setAttribute('aria-current', 'page');
  });
  const links = [...document.querySelectorAll('[data-toc-target]')];
  const setActive = id => links.forEach(link => {
    if (link.dataset.tocTarget === id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
  links.forEach(link => link.addEventListener('click', () => {
    const target = document.getElementById(link.dataset.tocTarget);
    if (target) {
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      setActive(target.id);
    }
  }));
  if ('IntersectionObserver' in window) {
    const observer = new window.IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a,b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: '-5% 0px -55% 0px' });
    links.forEach(link => {
      const target = document.getElementById(link.dataset.tocTarget);
      if (target) observer.observe(target);
    });
  }
}

// The editor calls the same trusted behavior from outside its script-free iframe.
if (typeof module !== 'undefined' && module.exports) module.exports = initializeBulletin;
else initializeBulletin(document, window);
