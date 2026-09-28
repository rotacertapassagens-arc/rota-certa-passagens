document.querySelectorAll('[data-toggle-for]').forEach((button) => {
  const input = document.getElementById(button.getAttribute('data-toggle-for'));
  if (!input) return;
  button.addEventListener('click', () => {
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    button.textContent = shown ? 'Mostrar' : 'Ocultar';
    button.setAttribute('aria-pressed', String(!shown));
  });
});

const rules = {
  len: (value) => value.length >= 12,
  upper: (value) => /[A-Z]/.test(value),
  lower: (value) => /[a-z]/.test(value),
  digit: (value) => /\d/.test(value),
};

document.querySelectorAll('.password-checklist').forEach((list) => {
  const input = document.querySelector(`[aria-describedby~="${list.id}"]`);
  if (!input) return;
  const items = list.querySelectorAll('li[data-rule]');
  const update = () => {
    const value = input.value;
    items.forEach((item) => {
      const rule = rules[item.getAttribute('data-rule')];
      item.classList.toggle('met', Boolean(rule && rule(value)));
    });
  };
  input.addEventListener('input', update);
  input.form?.addEventListener('reset', () => setTimeout(update));
  update();
});
