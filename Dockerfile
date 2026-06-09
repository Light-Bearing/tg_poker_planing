FROM python:3.11-alpine

# Установка системных зависимостей
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

# Expose порт
EXPOSE 8000

# Запуск приложения
CMD ["python", "main.py"]