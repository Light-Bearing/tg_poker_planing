FROM python:3.11-alpine

# Установка системных зависимостей (минимальный набор)
RUN apk add --no-cache gcc musl-dev

WORKDIR /app

# Копирование requirements отдельно для кеширования
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Копирование остального кода
COPY . .

# Создание непривилегированного пользователя
RUN adduser -D myuser
USER myuser

# Запуск приложения
CMD ["python", "main.py"]