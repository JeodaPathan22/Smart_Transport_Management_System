document.addEventListener('DOMContentLoaded', () => {
  // Top-right "Login" dropdown (guest header actions).
  const loginBtn = document.getElementById('loginBtn');
  const loginMenu = document.getElementById('loginMenu');
  const loginContainer = document.querySelector('.login-dropdown');

  if (loginBtn && loginMenu && loginContainer) {
    loginBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      loginMenu.classList.toggle('show');
      loginContainer.classList.toggle('active');
    });

    document.addEventListener('click', (e) => {
      if (!loginContainer.contains(e.target)) {
        loginMenu.classList.remove('show');
        loginContainer.classList.remove('active');
      }
    });
  }

  // Home page "From / To" swap button on the bus search card, if present.
  const swapBtn = document.getElementById('swapLocations');
  const fromLocation = document.getElementById('from-location');
  const toLocation = document.getElementById('to-location');

  if (swapBtn && fromLocation && toLocation) {
    swapBtn.addEventListener('click', () => {
      const fromValue = fromLocation.value;
      const toValue = toLocation.value;
      fromLocation.value = toValue;
      toLocation.value = fromValue;
    });
  }

  // Generic confirm-before-submit for destructive admin actions
  // (delete buttons carry data-confirm="...").
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      const msg = form.getAttribute('data-confirm') || 'Are you sure?';
      // eslint-disable-next-line no-alert
      if (!window.confirm(msg)) {
        e.preventDefault();
      }
    });
  });
});
