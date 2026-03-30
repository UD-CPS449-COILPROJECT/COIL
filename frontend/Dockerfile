FROM nginx:1.27-alpine

WORKDIR /usr/share/nginx/html

# Replace default sample content with our frontend assets.
RUN rm -rf *
COPY src ./src
COPY index.html .
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
