from binance.client import Client
from binance.enums import *

# 1. Conecte com suas chaves de API da corretora
api_key = "SUA_API_KEY"
api_secret = "SUA_SECRET_KEY"
client = Client(api_key, api_secret)

# 2. Verificar saldo existente da moeda base (ex: USDT)
symbol_target = "BTCUSDT"
base_asset = "USDT"

balance = client.get_asset_balance(asset=base_asset)
print(f"Saldo disponível em {base_asset}: {balance['free']}")

# 3. Criar uma ordem usando o saldo existente
try:
  # Exemplo: Ordem de compra a mercado (MARKET) usando o saldo em USDT
  order = client.order_market_buy(symbol=symbol_target, quantity=0.001)  # Ajuste a quantidade conforme o saldo e o preço atual
  print("Ordem criada com sucesso:", order)
except Exception as e:
  print("Erro ao criar ordem:", e)