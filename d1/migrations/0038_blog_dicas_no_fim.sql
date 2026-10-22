-- Ordem das regiões do blog: os destinos primeiro e a categoria "Dicas de viagem" por último, como pedia o PR #24.
-- A 0036 deu a ela MAX+1 (4 em produção), e as regiões novas de destino (América do Sul 4, Américas 5, Caribe 6) ficariam depois dela.
-- Só muda a ordem dessa categoria; nenhum post e nenhuma outra região é tocada.
UPDATE blog_regions SET sort_order = 99 WHERE id = 'dicas-de-viagem';
