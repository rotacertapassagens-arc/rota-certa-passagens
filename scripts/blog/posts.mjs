// Conteúdo dos Guias de viagem (blog). Para publicar um post novo: acrescente um item em `posts`,
// coloque as fotos em public/assets/blog/<foto>.jpg (1600 px) e <foto>-m.jpg (900 px) e rode
// `npm run blog:build`. Regra da casa: nada de preço, número ou regra de visto inventado; o que
// muda com frequência (entrada no país, horários, ingressos) aponta para os canais oficiais.

export const atualizado = { iso: '2026-09-29', texto: 'setembro de 2026' };

export const regioes = [
  { id: 'brasil', nome: 'Brasil' },
  { id: 'portugal', nome: 'Portugal' },
  { id: 'europa', nome: 'Europa' },
];

const dicas = (titulo, itens) => `<div class="tip"><h3>${titulo}</h3><ul>${itens.map((i) => `<li>${i}</li>`).join('')}</ul></div>`;

export const posts = [
  {
    slug: 'albania-praias-e-cidades-historicas',
    regiao: 'europa',
    destino: 'Albânia',
    destaque: true,
    titulo: 'Albânia: praias de água clara e cidades históricas longe das multidões',
    tituloHtml: 'Albânia: praias de água clara e cidades históricas <em>longe das multidões</em>',
    resumo: 'Riviera Albanesa, Butrint, Berat e Gjirokastër: por que a Albânia entrou no roteiro de quem já conhece o básico da Europa.',
    lede: 'Mar Jônico cor de piscina, cidades de pedra e montanhas: a Albânia é a Europa que ainda surpreende.',
    foto: 'albania',
    fotoAlt: 'Litoral da Albânia com água cristalina, um veleiro e um posto de salva-vidas',
    leitura: 6,
    corpo: `
<p>A Albânia fica nos Bálcãs, entre Montenegro, Kosovo, Macedônia do Norte e Grécia, com litoral no Mar Adriático e no Mar Jônico. Durante décadas ficou fora do radar dos viajantes, e é justamente isso que atrai hoje: praias de água clara, história de mais de dois mil anos e um ritmo mais tranquilo do que o dos vizinhos mais famosos.</p>
<h2><span class="num">01</span>A Riviera Albanesa</h2>
<p>O trecho de litoral entre Vlorë e Sarandë concentra as praias mais bonitas do país. Algumas paradas que valem o caminho:</p>
<ul>
<li><strong>Ksamil:</strong> pequenas ilhas a poucos metros da areia e água transparente. É a praia mais procurada, então vale chegar cedo na alta temporada.</li>
<li><strong>Sarandë:</strong> cidade com boa estrutura de hotéis e restaurantes, uma ótima base para explorar o sul.</li>
<li><strong>Himarë e Dhërmi:</strong> vilas com praias de pedrinhas e mar muito azul, mais tranquilas que Ksamil.</li>
</ul>
<h2><span class="num">02</span>Butrint, uma cidade de muitas épocas</h2>
<p>Perto de Ksamil fica o Parque Nacional de Butrint, sítio arqueológico declarado Patrimônio Mundial pela UNESCO. Em meio ao verde há ruínas gregas, romanas, bizantinas e venezianas, incluindo um teatro antigo. Reserve algumas horas e leve água: quase toda a visita é ao ar livre.</p>
<h2><span class="num">03</span>Berat e Gjirokastër</h2>
<p>As duas cidades formam, juntas, um Patrimônio Mundial da UNESCO e guardam a arquitetura do período otomano. Berat é conhecida como a cidade das mil janelas, pelas casas brancas empilhadas na encosta. Gjirokastër tem ruas de pedra, telhados de lajes cinzentas e um castelo no alto, com vista para o vale.</p>
<h2><span class="num">04</span>Tirana e as montanhas</h2>
<p>A capital, Tirana, é colorida e animada, com cafés, a Praça Skanderbeg e o Bunk'Art, museu instalado num antigo bunker da Guerra Fria. Para quem gosta de natureza, os Alpes Albaneses, no norte, têm trilhas famosas, como a que liga Valbona a Theth.</p>
${dicas('Dicas práticas', [
  '<strong>Quando ir:</strong> junho e setembro costumam ter mar quente e menos gente do que julho e agosto.',
  '<strong>Como chegar:</strong> o principal aeroporto é o de Tirana. No sul, ferries ligam a ilha grega de Corfu a Sarandë, uma boa combinação para quem já está na Grécia.',
  '<strong>Como circular:</strong> carro alugado dá liberdade para percorrer a Riviera. As estradas de montanha pedem calma e tempo.',
  '<strong>Dinheiro:</strong> a moeda é o lek. Em áreas turísticas às vezes aceitam euro, mas o troco costuma vir em lek.',
  '<strong>Entrada:</strong> a Albânia não faz parte do espaço Schengen e tem regras próprias. Confira o que vale para o seu passaporte nos canais oficiais antes de viajar.',
])}`,
  },
  {
    slug: 'lisboa-em-3-dias',
    regiao: 'portugal',
    destino: 'Lisboa',
    titulo: 'Lisboa em 3 dias: bairros, miradouros e o que não pode faltar',
    tituloHtml: 'Lisboa em 3 dias: bairros, miradouros e o que <em>não pode faltar</em>',
    resumo: 'Alfama, Belém, Chiado e um pôr do sol num miradouro: o essencial de Lisboa num roteiro possível.',
    lede: 'Alfama, Belém, Chiado e um pôr do sol num miradouro: o essencial de Lisboa num roteiro possível.',
    foto: 'lisboa',
    fotoAlt: 'Telhados vermelhos da Alfama, em Lisboa, com o rio Tejo ao fundo',
    leitura: 5,
    corpo: `
<p>Lisboa é uma cidade de colinas, luz e elétricos amarelos. É também uma das capitais europeias onde a gente se sente em casa com mais facilidade: a língua ajuda, a comida conforta e cada miradouro parece feito para o fim de tarde.</p>
<h2><span class="num">Dia 1</span>Baixa, Chiado e Alfama</h2>
<p>Comece pela <strong>Praça do Comércio</strong> e suba a Rua Augusta até o Rossio. O <strong>Elevador de Santa Justa</strong> leva ao Carmo e ao <strong>Chiado</strong>, bairro de cafés e livrarias. À tarde, suba até a <strong>Alfama</strong>: a Sé de Lisboa, os miradouros de Santa Luzia e das Portas do Sol e o <strong>Castelo de São Jorge</strong>. À noite, fado na Alfama ou na Mouraria.</p>
<h2><span class="num">Dia 2</span>Belém e LX Factory</h2>
<p>Em Belém ficam a <strong>Torre de Belém</strong> e o <strong>Mosteiro dos Jerónimos</strong>, ambos Patrimônio Mundial da UNESCO, além do Padrão dos Descobrimentos. Os pastéis de Belém, servidos quentes com canela, são parada obrigatória. No fim da tarde, a <strong>LX Factory</strong>, antiga fábrica transformada em espaço de lojas e restaurantes, fica no caminho de volta ao centro.</p>
<h2><span class="num">Dia 3</span>Sintra</h2>
<p>Os trens para <strong>Sintra</strong> saem da estação do Rossio, e a viagem é curta. Por lá, o <strong>Palácio da Pena</strong>, colorido no alto da serra, e a <strong>Quinta da Regaleira</strong>, com jardins e o famoso poço iniciático, ocupam o dia inteiro. Na alta temporada, compre os ingressos com antecedência.</p>
<h2><span class="num">Extra</span>Miradouros para o pôr do sol</h2>
<p>Além de Santa Luzia e Portas do Sol, vale subir ao <strong>Miradouro da Senhora do Monte</strong>, um dos pontos mais altos da cidade, ao da <strong>Graça</strong> e ao de <strong>São Pedro de Alcântara</strong>, no Bairro Alto.</p>
${dicas('Dicas práticas', [
  '<strong>Elétrico 28:</strong> passa pelos bairros mais bonitos, mas lota. Vá cedo.',
  '<strong>Transporte:</strong> o cartão Viva Viagem é recarregável e vale para metrô, elétricos, ônibus e trens urbanos.',
  '<strong>Sapatos:</strong> a calçada portuguesa é linda e escorregadia, principalmente nas ladeiras e em dia de chuva.',
  '<strong>Onde ficar:</strong> Baixa e Chiado para fazer muita coisa a pé; Príncipe Real e Avenida da Liberdade para algo mais tranquilo.',
])}`,
  },
  {
    slug: 'roma-em-4-dias',
    regiao: 'europa',
    destino: 'Roma',
    titulo: 'Roma em 4 dias: roteiro para a primeira viagem',
    tituloHtml: 'Roma em 4 dias: roteiro para a <em>primeira viagem</em>',
    resumo: 'Coliseu, Vaticano, praças e fontes: um roteiro possível, sem correria, para conhecer o essencial da Cidade Eterna.',
    lede: 'Coliseu, Vaticano, praças e fontes: um roteiro possível, sem correria, para conhecer o essencial da Cidade Eterna.',
    foto: 'roma',
    fotoAlt: 'Coliseu de Roma ao pôr do sol, emoldurado por árvores',
    leitura: 6,
    corpo: `
<p>Roma é uma cidade para caminhar. Boa parte do centro histórico cabe em trajetos a pé, e cada esquina guarda uma igreja, uma praça ou uma ruína com dois mil anos de história. Em quatro dias dá para ver o essencial com calma, desde que os ingressos principais estejam reservados antes.</p>
<h2><span class="num">Dia 1</span>Roma Antiga</h2>
<p>Comece pelo <strong>Coliseu</strong>, pelo <strong>Fórum Romano</strong> e pelo <strong>Monte Palatino</strong>, que ficam lado a lado e costumam ser visitados com o mesmo ingresso. Reserve horário no site oficial, principalmente na alta temporada. No fim da tarde, caminhe até a Piazza Venezia e o Vittoriano, monumento com um terraço panorâmico sobre a cidade.</p>
<h2><span class="num">Dia 2</span>Vaticano</h2>
<p>Os <strong>Museus Vaticanos</strong> terminam na <strong>Capela Sistina</strong>, e a visita pode levar a manhã inteira. Depois, siga para a <strong>Basílica de São Pedro</strong> e a praça em frente. Quem tiver fôlego pode subir à cúpula, que tem uma das vistas mais bonitas de Roma. Nas igrejas e no Vaticano, ombros e joelhos precisam estar cobertos. À tarde, desça a Via della Conciliazione até o <strong>Castel Sant'Angelo</strong>, às margens do rio Tibre.</p>
<h2><span class="num">Dia 3</span>Centro histórico</h2>
<p>Um dia para andar sem pressa entre o <strong>Panteão</strong>, a <strong>Piazza Navona</strong>, o mercado do <strong>Campo de' Fiori</strong>, a <strong>Fontana di Trevi</strong> e a <strong>Escadaria da Praça de Espanha</strong>. Na Fontana di Trevi, a tradição manda jogar uma moeda de costas para garantir a volta a Roma. Na Escadaria, não é permitido sentar nos degraus.</p>
<h2><span class="num">Dia 4</span>Villa Borghese e Trastevere</h2>
<p>Pela manhã, visite a <strong>Galleria Borghese</strong>, com obras de Bernini e Caravaggio, que só recebe visitantes com reserva. Depois, passeie pelo parque da Villa Borghese e siga até o Pincio para ver a Piazza del Popolo do alto. Termine o dia no <strong>Trastevere</strong>, bairro de ruelas e restaurantes do outro lado do rio.</p>
${dicas('Dicas práticas', [
  '<strong>Reservas:</strong> Coliseu, Museus Vaticanos e Galleria Borghese têm vagas por horário. Compre nos sites oficiais e desconfie de revendas com preço inflado.',
  '<strong>Água:</strong> Roma tem bebedouros públicos, os nasoni, com água potável. Leve uma garrafa.',
  '<strong>Sapatos:</strong> o calçamento de pedra cansa. Um tênis confortável faz diferença.',
  '<strong>Quando ir:</strong> primavera e outono costumam ser mais agradáveis. No verão, evite as horas mais quentes do dia.',
  '<strong>Onde ficar:</strong> perto da Piazza Navona ou do Panteão para fazer quase tudo a pé; no Trastevere para jantar perto do hotel; perto da estação Termini para ter mais opções de transporte.',
])}`,
  },
  {
    slug: 'voltar-ao-brasil-nas-ferias',
    regiao: 'brasil',
    destino: 'Brasil',
    titulo: 'Voltar ao Brasil nas férias: como planejar a viagem saindo de Portugal',
    tituloHtml: 'Voltar ao Brasil nas férias: como planejar a viagem <em>saindo de Portugal</em>',
    resumo: 'Datas, rotas, bagagem, documentos e milhas: um guia para quem mora em Portugal e quer rever a família no Brasil sem sustos.',
    lede: 'Datas, rotas, bagagem, documentos e milhas: um guia para quem mora em Portugal e quer rever a família no Brasil sem sustos.',
    foto: 'brasil',
    fotoAlt: 'Vista do alto do Rio de Janeiro, com o Pão de Açúcar e a baía de Guanabara',
    leitura: 5,
    ctaTitulo: 'Vai <em>voltar ao Brasil</em>?',
    ctaTexto: 'Conte de onde sai, para qual cidade vai e as datas. A nossa equipe prepara a proposta de voo, em dinheiro ou em milhas, e responde por e-mail em até 48 horas.',
    corpo: `
<p>Para quem mora em Portugal, a viagem ao Brasil é mais do que férias: é reencontro. Justamente por isso, costuma cair nas mesmas datas que todo mundo escolhe. Planejar com antecedência faz diferença no preço, no conforto e na tranquilidade.</p>
<h2><span class="num">01</span>Quando comprar</h2>
<p>Dezembro, janeiro e julho estão entre as épocas mais procuradas, por causa do fim de ano e das férias escolares. Nessas datas, os voos lotam cedo. Comprar com meses de antecedência e ter alguma flexibilidade, nem que seja de um ou dois dias, ajuda a encontrar opções melhores.</p>
<h2><span class="num">02</span>Direto ou com conexão</h2>
<p>Lisboa tem voos diretos para várias capitais brasileiras. Saindo do Porto, ou quando o destino final é uma cidade menor, as conexões ampliam as opções. Um voo com conexão pode sair mais em conta, mas compare o tempo total de viagem, principalmente com crianças ou idosos.</p>
<h2><span class="num">03</span>As milhas contam muito</h2>
<p>Em datas concorridas, usar milhas pode reduzir bastante o custo da passagem. Na Rota Certa, a proposta de voo pode vir em dinheiro, em milhas ou nos dois formatos, para você comparar e escolher.</p>
<h2><span class="num">04</span>Bagagem sem sustos</h2>
<ul>
<li>A franquia muda conforme a companhia e a tarifa. Algumas tarifas mais baratas não incluem mala despachada.</li>
<li>Pese as malas antes de sair de casa: presentes e encomendas da família costumam pesar mais do que parece.</li>
<li>Alimentos têm regras de entrada, tanto no Brasil quanto na União Europeia, especialmente os de origem animal. Confira antes de colocar na mala.</li>
</ul>
<h2><span class="num">05</span>Documentos</h2>
<ul>
<li>Passaporte válido para toda a viagem.</li>
<li>Para quem mora em Portugal, o título ou cartão de residência válido, para voltar sem problemas.</li>
<li>Crianças e adolescentes que viajam sem os dois responsáveis podem precisar de autorização. Confira as exigências antes de comprar a passagem.</li>
</ul>
${dicas('Checklist rápido', [
  'Datas definidas, com alguma flexibilidade',
  'Voo direto e com conexão comparados',
  'Cotação em dinheiro e em milhas',
  'Franquia de bagagem conferida na tarifa',
  'Passaporte e residência válidos',
])}`,
  },
  {
    slug: 'paris-primeira-viagem',
    regiao: 'europa',
    destino: 'Paris',
    titulo: 'Paris na primeira viagem: o que ver e como se organizar',
    tituloHtml: 'Paris na primeira viagem: o que ver e <em>como se organizar</em>',
    resumo: 'Torre Eiffel, Louvre, Montmartre e o Sena: um guia para aproveitar Paris sem perder tempo em filas.',
    lede: 'Torre Eiffel, Louvre, Montmartre e o Sena: um guia para aproveitar Paris sem perder tempo em filas.',
    foto: 'paris',
    fotoAlt: 'Rio Sena ao entardecer em Paris, com barcos e pontes',
    leitura: 6,
    corpo: `
<p>Paris recompensa quem se organiza. Os monumentos mais famosos vendem ingressos com hora marcada, e alguns fecham em dias fixos da semana. Com um pouco de planejamento, sobra tempo para o que a cidade tem de melhor: caminhar sem rumo, sentar num café e ver o Sena ao entardecer.</p>
<h2><span class="num">01</span>O essencial</h2>
<ul>
<li><strong>Torre Eiffel:</strong> suba no fim da tarde para ver a cidade de dia e acesa. Os ingressos com hora marcada são vendidos no site oficial.</li>
<li><strong>Louvre:</strong> reserve horário e escolha algumas alas, porque é impossível ver tudo de uma vez. O museu fecha às terças-feiras.</li>
<li><strong>Museu d'Orsay:</strong> o endereço dos impressionistas, dentro de uma antiga estação de trem. Fecha às segundas-feiras.</li>
<li><strong>Île de la Cité:</strong> a Catedral de Notre-Dame, reaberta em dezembro de 2024 depois do incêndio de 2019, e a Sainte-Chapelle, famosa pelos vitrais.</li>
<li><strong>Montmartre:</strong> ruas em ladeira, artistas na Place du Tertre e a vista da Basílica de Sacré-Cœur.</li>
</ul>
<h2><span class="num">02</span>Um roteiro de 4 dias</h2>
<ul>
<li><strong>Dia 1:</strong> Torre Eiffel, Trocadéro e um passeio de barco pelo Sena.</li>
<li><strong>Dia 2:</strong> Louvre, Jardim das Tulherias e Champs-Élysées até o Arco do Triunfo.</li>
<li><strong>Dia 3:</strong> Notre-Dame, Sainte-Chapelle e o bairro do Marais.</li>
<li><strong>Dia 4:</strong> Montmartre pela manhã e Museu d'Orsay à tarde, lembrando que ele fecha às segundas.</li>
</ul>
<p>Com um dia a mais, vale o bate e volta ao <strong>Palácio de Versalhes</strong>, que também fecha às segundas-feiras.</p>
<h2><span class="num">03</span>Onde ficar</h2>
<p>O <strong>Marais</strong> é central, charmoso e cheio de restaurantes. <strong>Saint-Germain-des-Prés</strong> e o <strong>Quartier Latin</strong> ficam na margem esquerda, com livrarias e cafés clássicos. Perto da Torre Eiffel as noites são mais tranquilas, mas você vai depender mais do metrô.</p>
${dicas('Dicas práticas', [
  '<strong>Metrô:</strong> cobre a cidade inteira e é o jeito mais rápido de circular entre bairros distantes.',
  '<strong>Museus:</strong> se for visitar muitos museus, compare o preço dos ingressos avulsos com o Paris Museum Pass.',
  '<strong>Atenção:</strong> em áreas turísticas e no metrô, cuidado com batedores de carteira.',
  '<strong>Educação:</strong> um "bonjour" ao entrar em lojas e restaurantes muda o atendimento.',
])}`,
  },
  {
    slug: 'istambul-primeira-visita',
    regiao: 'europa',
    destino: 'Istambul',
    titulo: 'Istambul entre dois continentes: guia da primeira visita',
    tituloHtml: 'Istambul entre <em>dois continentes</em>: guia da primeira visita',
    resumo: 'Mesquitas, bazares e o Bósforo: como aproveitar a cidade onde a Europa encontra a Ásia.',
    lede: 'Mesquitas, bazares e o Bósforo: como aproveitar a cidade onde a Europa encontra a Ásia.',
    foto: 'istambul',
    fotoAlt: 'Mesquita de Ortaköy à beira do Bósforo, com a ponte ao fundo, em Istambul',
    leitura: 6,
    corpo: `
<p>Istambul fica dos dois lados do Estreito do Bósforo, com uma parte na Europa e outra na Ásia. Foi capital de impérios por mais de 1.500 anos, e isso aparece em cada esquina: mesquitas, palácios, bazares e uma vida de rua intensa, que vai até tarde da noite.</p>
<h2><span class="num">01</span>Sultanahmet, o centro histórico</h2>
<p>Os monumentos mais famosos ficam perto uns dos outros:</p>
<ul>
<li><strong>Santa Sofia:</strong> construída como basílica no século VI, hoje funciona como mesquita. Turistas têm horários e regras próprias de visita, então confira antes de ir.</li>
<li><strong>Mesquita Azul:</strong> oficialmente Mesquita do Sultão Ahmed, famosa pelos azulejos azuis do interior.</li>
<li><strong>Cisterna da Basílica:</strong> um reservatório subterrâneo da época bizantina, com centenas de colunas.</li>
<li><strong>Palácio de Topkapi:</strong> residência dos sultões otomanos durante séculos, com pátios, joias e vista para o Bósforo.</li>
</ul>
<h2><span class="num">02</span>Bazares</h2>
<p>O <strong>Grande Bazar</strong> é um dos maiores mercados cobertos do mundo, com milhares de lojas. O <strong>Bazar das Especiarias</strong>, perto do porto de Eminönü, é o lugar de chás, doces e temperos. Nos dois, pechinchar faz parte da conversa.</p>
<h2><span class="num">03</span>O Bósforo e o lado asiático</h2>
<p>Um passeio de barco pelo Bósforo mostra palácios, casarões à beira d'água e a mesquita de Ortaköy sob a ponte. Os ferries públicos também são um jeito simples de cruzar para o lado asiático, até bairros como <strong>Kadıköy</strong> e <strong>Üsküdar</strong>, com mercados e restaurantes frequentados pelos moradores.</p>
<h2><span class="num">04</span>Gálata e Beyoğlu</h2>
<p>Do outro lado do Chifre de Ouro, a <strong>Torre de Gálata</strong> tem vista para toda a cidade, e a <strong>Avenida Istiklal</strong>, só para pedestres, é percorrida por um bonde histórico.</p>
${dicas('Dicas práticas', [
  '<strong>Nas mesquitas:</strong> ombros e joelhos cobertos, sapatos fora e, para mulheres, cabelo coberto. As visitas pausam nos horários de oração.',
  '<strong>Transporte:</strong> o cartão Istanbulkart vale para metrô, bonde, ônibus e ferries.',
  '<strong>Aeroportos:</strong> a cidade tem dois. O Aeroporto de Istambul (IST) fica do lado europeu, e o Sabiha Gökçen (SAW), do lado asiático. Confira qual é o do seu voo.',
  '<strong>Entrada:</strong> confira as regras de entrada na Turquia para o seu passaporte nos canais oficiais antes de viajar.',
])}`,
  },
];
