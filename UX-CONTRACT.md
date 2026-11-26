# Navegação e conversas

- **Barra lateral**. Atividade reúne pedidos de amizade e convites de grupo. Amigos abre a conversa individual, com presença e contador ao lado do nome. Grupos abre o chat e mostra acesso a Salas e Pessoas. No celular, escolher um destino recolhe o menu.
- **Conversas**. A chamada é iniciada pelo botão Ligar ou atendida pelo botão Atender. O histórico mostra mensagens da conta e de seus interlocutores. A leitura avança quando a conversa está visível. A atualização em segundo plano preserva o conteúdo e o campo em edição.
- **Convites**. Donos podem convidar amigos aceitos. A pessoa convidada aceita ou recusa na Atividade. Grupos com histórico MLS continuam com a aprovação e as chaves exigidas por esse fluxo. Convites por link continuam disponíveis.
- **Componentes**. `WorkspaceRail` possui a navegação, `Conversation` possui o histórico e o campo de mensagem, `Modal` possui formulários e confirmações. O navegador cuida do teclado e do foco dos diálogos e seletores. O CSS global possui os tokens e estilos de foco.
- **Verificação**. `npm test` e `npm run test:browser` verificam acesso, mensagens, contadores, convites e entrada em reuniões.
