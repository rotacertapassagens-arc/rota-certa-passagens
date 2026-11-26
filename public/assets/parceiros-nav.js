const tocLinks = Array.from(document.querySelectorAll('.toc a[href^="#"]'));
const sections = tocLinks
  .map((link) => document.getElementById(link.getAttribute('href').slice(1)))
  .filter(Boolean);

if (tocLinks.length && sections.length && 'IntersectionObserver' in window) {
  const setActive = (id) => {
    tocLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${id}`));
    const active = tocLinks.find((link) => link.getAttribute('href') === `#${id}`);
    const bar = active && active.parentElement;
    if (bar && bar.scrollWidth > bar.clientWidth) {
      bar.scrollTo({ left: active.offsetLeft - bar.clientWidth / 2 + active.offsetWidth / 2, behavior: 'smooth' });
    }
  };
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting);
      if (visible.length) setActive(visible[0].target.id);
    },
    { rootMargin: '-45% 0px -50% 0px', threshold: 0 }
  );
  sections.forEach((section) => observer.observe(section));
}
