-- Categoria "Dicas de viagem" do blog (filtro em /blog/ e trilha de navegação nos artigos).
-- INSERT OR IGNORE: se a categoria já existir (criada pelo painel), nada muda. A ordem vai para o fim da lista.
-- Só aparece no filtro de /blog/ quando houver ao menos um artigo publicado nela (ver worker/blog.ts, comPosts).
INSERT OR IGNORE INTO blog_regions (id, name, sort_order)
VALUES ('dicas-de-viagem', 'Dicas de viagem', (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM blog_regions));
