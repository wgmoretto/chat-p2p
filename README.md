# Chat P2P

Piloto open source de chat interno, reuniões, compartilhamento de tela, lives e moderação. O servidor coordena acesso, sinalização, chat de grupo e sucessão de host. Os navegadores trocam áudio, vídeo e chat da sala por WebRTC, diretamente ou pelo coturn.

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
2. Crie um grupo e clique em **Convidar**. Abra o convite em outro perfil de navegador. Crie uma segunda conta, volte à aba **Pessoas** do dono e aprove o dispositivo.
3. Crie uma sala do tipo **Reunião** e entre nas duas contas. Use **Microfone**, **Câmera** ou **Compartilhar tela** para publicar.
4. Crie uma sala do tipo **Live**. Um membro pode iniciar uma transmissão e publicar câmera ou tela. Durante uma live, apenas esse membro pode publicar mídia.

Use o mesmo perfil de navegador para voltar à conta. As chaves do dispositivo e o histórico já decifrado vivem no armazenamento do navegador. Limpar esses dados, usar um perfil temporário ou trocar de dispositivo perde o acesso às chaves. O piloto não tem recuperação nem migração de dispositivo. O arquivo SQLite local fica em `data/chat.sqlite`.

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
5. Acesse `/healthz` pela URL da aplicação e repita a reunião com duas redes externas. Verifique o indicador **Direta**, redeploy com `FORCE_TURN=1` e confirme **Relay TURN** com áudio e tela. Volte para `0` e confirme que o histórico persiste após o redeploy.

O Compose publica TURN em UDP e TCP. Algumas redes exigem TURN/TLS, que precisa de certificado e porta próprios no coturn. WebRTC mantém o conteúdo cifrado entre os clientes também quando o relay usa TCP. Para usar um TURN separado, configure o mesmo segredo no relay externo e na API, informe as URLs públicas na API e remova o serviço `coturn` da configuração de deploy.

Para hospedar em um Windows Server, use a mesma configuração em uma VM Linux com Hyper-V. Configure o HTTPS da aplicação na VM e o acesso externo às portas do coturn. Para backup do servidor, use um backup consistente do SQLite, incluindo o WAL quando aplicável, e teste a restauração. As chaves privadas do navegador não fazem parte desse backup.

## Comportamento do piloto

- **Grupos privados** com até 32 membros, convites de uso único, aprovação pelo dono e histórico offline cifrado com MLS. O novo membro recebe mensagens posteriores à aprovação.
- **Reuniões** com até quatro pessoas. Microfone, câmera e tela usam conexões WebRTC independentes do host da sessão. O chat da sala é temporário e usa DataChannel.
- **Lives** de um transmissor e até quatro espectadores. Qualidade máxima selecionável de 480p, 720p ou 1080p. O transmissor envia por espectador e o WebRTC adapta os envios ao congestionamento. A resolução real depende do dispositivo, da captura e da rede.
- **Host** inicial é quem abre a sessão. Na saída ou expiração do heartbeat, o servidor elege o melhor candidato disponível e incrementa o mandato. Quem retorna entra como participante. O transmissor pode ser outra pessoa. Quando o transmissor sai, alguém na sala pode iniciar uma nova transmissão.
- **Moderação** com papéis de dono, moderador e membro. Na sessão, dono e moderadores podem controlar publicação e expulsar conforme o papel. O dono controla associação e banimento do grupo e autoriza a mudança de época MLS. Ações de sala são registradas no SQLite.
- **Criptografia** — o cliente assina a negociação SDP com a chave do dispositivo, incluindo sala, remetente, destinatário e instâncias. O convite inclui a chave do dono e precisa ser compartilhado por um canal confiável. O servidor ainda vê presença, identidade, permissões, horários e sinalização. A origem HTTPS que entrega o JavaScript e os dispositivos participantes fazem parte da fronteira de confiança. O pacote `ts-mls` ainda não informa auditoria independente. Valide o desenho de segurança antes de usar com informação sensível. [WebRTC RFC 8827](https://www.rfc-editor.org/rfc/rfc8827.html) · [MLS RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html) · [ts-mls](https://github.com/LukaJCB/ts-mls)

## Verificação

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:browser
```

Os testes de navegador usam perfis isolados e dispositivos de mídia de teste no Chrome. A qualidade de produção, o coturn publicado e o desempenho em redes distintas exigem o aceite após a instalação. O piloto tem o servidor de controle em uma réplica e mantém a eleição e a presença em memória. Após reiniciar esse processo, os clientes voltam a entrar nas salas.
