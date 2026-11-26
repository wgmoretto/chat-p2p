# Chat P2P

Piloto open source de chat interno, reuniões, compartilhamento de tela, lives e moderação. O servidor coordena login, amizades, sinalização e sucessão de host. Os navegadores trocam áudio e vídeo por WebRTC, diretamente ou pelo coturn. O chat da sala continua disponível pela conexão com o servidor se o canal WebRTC falhar.

## Rodar no Windows

Requisitos — Node.js 24 ou mais recente e Chrome ou Edge desktop.

```powershell
npm.cmd ci
npm.cmd run build
$env:BOOTSTRAP_TOKEN = node -p "require('node:crypto').randomBytes(24).toString('hex')"
Write-Host "Código de instalação para esta sessão de terminal"
Write-Host $env:BOOTSTRAP_TOKEN
npm.cmd start
```

1. Abra [http://localhost:3000](http://localhost:3000). Crie a primeira conta com o código de instalação. A senha precisa ter ao menos 12 caracteres.
2. Após a configuração inicial, cada pessoa pode criar uma conta com usuário e senha. A mesma conta pode entrar em outro perfil ou dispositivo.
3. Em **Amigos**, adicione alguém pelo `@usuário` e aguarde o aceite. Clique em **Conversar**. O outro participante verá **Atender** e poderá entrar. O chat existe durante a sessão.
4. Para mais pessoas, crie um grupo privado, compartilhe o convite e abra uma sala do tipo **Reunião** ou **Live**. Use **Microfone**, **Câmera** e **Compartilhar tela** para publicar. Em uma live, um participante transmite por vez.

O SQLite local fica em `data/chat.sqlite` e guarda contas, amizades e grupos. O login e as amizades são independentes das chaves de um navegador.

## Publicar no Easypanel

1. No projeto `chat-p2p`, crie um serviço **Compose** com origem no Git e indique o arquivo `compose.yaml`. O repositório precisa estar acessível ao Easypanel. Uma instalação usa uma réplica da aplicação.
2. Em **Domains**, aponte `chat.seudominio.com` para o serviço `app`, porta interna `3000`, com HTTPS. A API e o WebSocket usam o mesmo domínio. O volume `chat-data` guarda o SQLite em `/data`. [Easypanel Compose](https://easypanel.io/docs/services/compose)
3. Na área de variáveis do Compose, configure os valores abaixo. Gere **dois segredos diferentes** usando `node -p "require('node:crypto').randomBytes(32).toString('hex')"`. Guarde os valores no painel.

| Variável | Valor |
| --- | --- |
| `PUBLIC_ORIGIN` | Origem HTTPS da aplicação, por exemplo `https://chat.seudominio.com`. |
| `BOOTSTRAP_TOKEN` | Segredo para cadastrar a primeira conta. Pode ser retirado após o cadastro. |
| `TURN_SECRET` | Segredo compartilhado entre a API e o coturn para emitir credenciais temporárias. |
| `TURN_REALM` | Hostname do TURN, por exemplo `turn.seudominio.com`. |
| `TURN_EXTERNAL_IP` | IPv4 público anunciado pelo coturn. |
| `TURN_URLS` | `turn:turn.seudominio.com:3478?transport=udp,turn:turn.seudominio.com:3478?transport=tcp` |
| `STUN_URLS` | `stun:turn.seudominio.com:3478` |
| `TURN_CAPACITY_BYTES_PER_SECOND` | Limite de banda configurado no relay. O Compose começa com 10.000.000 bytes/s. |
| `FORCE_TURN` | Padrão `0`. Use `1` temporariamente para testar o relay. |
| `TRUST_PROXY` | `1` atrás do proxy do Easypanel, que controla o cabeçalho de encaminhamento. Use `0` se executar a aplicação diretamente. |

4. Aponte o DNS de `turn.seudominio.com` diretamente para o IP público. Abra `3478/TCP`, `3478/UDP` e `49160–49200/UDP` no firewall do servidor e do provedor. O Compose reserva essas portas. Se o VPS estiver atrás de NAT, encaminhe cada porta de relay para o mesmo número interno. [Contêiner coturn](https://github.com/coturn/coturn/blob/master/docker/coturn/README.md)
5. Acesse `/healthz` pela URL da aplicação e repita a reunião com duas redes externas. Verifique o indicador **Direta**, redeploy com `FORCE_TURN=1` e confirme **Relay TURN** com áudio e tela. Volte para `0` e confirme que contas, amizades e grupos persistem após o redeploy.

Se os participantes aparecem, mas a sala mostra **Mídia indisponível**, verifique o DNS público do TURN, o IPv4 em `TURN_EXTERNAL_IP` e as portas do passo 4. Teste com duas redes externas e `FORCE_TURN=1` antes de voltar a `0`.

O Compose publica TURN em UDP e TCP. Algumas redes exigem TURN/TLS, que precisa de certificado e porta próprios no coturn. WebRTC mantém o conteúdo cifrado entre os clientes também quando o relay usa TCP. Para usar um TURN separado, configure o mesmo segredo no relay externo e na API, informe as URLs públicas na API e remova o serviço `coturn` da configuração de deploy.

Para hospedar em um Windows Server, use a mesma configuração em uma VM Linux com Hyper-V. Configure o HTTPS da aplicação na VM e o acesso externo às portas do coturn. Para backup do servidor, use um backup consistente do SQLite, incluindo o WAL quando aplicável, e teste a restauração. As chaves privadas do navegador não fazem parte desse backup.

## Habilitar TURN em um App existente no Easypanel

Se o chat já roda em um serviço **App**, adicione um serviço **Compose** separado, com origem no mesmo repositório e arquivo `compose.turn.yaml`. Esse serviço sobe o coturn e o chat continua usando o banco do App atual. Se a instalação já tem o `coturn` do Compose completo, use aquele serviço.

No Compose do coturn, em **Environment**, ative **Create .env file** e preencha `TURN_REALM`, `TURN_EXTERNAL_IP` e `TURN_SECRET` conforme a tabela acima. No App existente, configure `TURN_URLS`, `STUN_URLS` e o mesmo `TURN_SECRET`. Aponte o hostname do TURN para o IPv4 público com DNS direto e libere as portas do passo 4. Após subir o relay e fazer o redeploy do App, recarregue ambos os navegadores e entre novamente na chamada. [Easypanel Compose](https://easypanel.io/docs/services/compose)

## Atualizar uma instalação existente

Faça o redeploy a partir da `main` preservando o volume `chat-data`. Entre com o usuário e a senha que você já usa. Contas e grupos existentes são preservados. As chaves dos grupos MLS antigos ficam no perfil e no endereço usados antes da atualização. Use esse navegador para abrir as salas e ler o histórico desses grupos.

O código de instalação continua reservado à criação da primeira conta em um banco vazio. As contas seguintes podem se cadastrar e enviar pedidos sem um convite de grupo. Pedidos dependem de aceite e grupos seguem privados.

## Comportamento do piloto

- **Amizades** por `@usuário`, com pedido e aceite. Cada dupla tem uma conversa privada temporária e pode fazer uma chamada com áudio, câmera e tela.
- **Grupos privados** com até 32 membros e convites de uso único. Nos novos grupos, o chat acontece nas salas e dura a sessão. Os grupos MLS existentes mantêm seu histórico e suas chaves locais.
- **Reuniões** com até quatro pessoas. Microfone, câmera e tela usam conexões WebRTC independentes do host da sessão. O chat da sala dura a sessão e prioriza o canal de dados WebRTC. Se esse canal estiver indisponível, o servidor encaminha somente mensagens cifradas.
- **Lives** de um transmissor e até quatro espectadores. Qualidade máxima selecionável de 480p, 720p ou 1080p. O transmissor envia por espectador e o WebRTC adapta os envios ao congestionamento. A resolução real depende do dispositivo, da captura e da rede.
- **Host** inicial é quem abre a sessão. Na saída ou expiração do heartbeat, o servidor elege o melhor candidato disponível e incrementa o mandato. Quem retorna entra como participante. O transmissor pode ser outra pessoa. Quando o transmissor sai, alguém na sala pode iniciar uma nova transmissão.
- **Moderação** com papéis de dono, moderador e membro. Na sessão, dono e moderadores podem controlar publicação e expulsar conforme o papel. O dono controla associação e banimento do grupo. Em grupos MLS antigos, mudanças de membros seguem o fluxo cifrado existente. Ações de sala são registradas no SQLite.
- **Criptografia** — a mídia usa WebRTC cifrado entre navegadores, inclusive via TURN. O chat da sala é cifrado no navegador antes do envio por WebRTC ou WebSocket. Nas sessões novas, o servidor autenticado associa a conta à chave temporária usada para assinar o SDP e autenticar a chave do chat. Os grupos MLS antigos continuam usando as chaves verificadas dos dispositivos. O servidor vê presença, identidade, permissões, horários e sinalização. [WebRTC RFC 8827](https://www.rfc-editor.org/rfc/rfc8827.html) · [MLS RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html) · [ts-mls](https://github.com/LukaJCB/ts-mls)

## Verificação

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:browser
```

Os testes de navegador usam perfis isolados e dispositivos de mídia de teste no Chrome. Use `$env:TEST_ICE_BLOCKED = '1'` antes de `npm.cmd run test:browser` para verificar o chat cifrado ao bloquear a mídia WebRTC. A qualidade de produção, o coturn publicado e o desempenho em redes distintas exigem o aceite após a instalação. O piloto tem o servidor de controle em uma réplica e mantém a eleição e a presença em memória. Após reiniciar esse processo, os clientes voltam a entrar nas salas.
