# SkillOps 团队版镜像
FROM node:20-alpine

WORKDIR /app

# 只拷贝运行时源码（零依赖，无需 npm install）
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV SKILLOPS_SKILLS_DIR=/skills
ENV SKILLOPS_REPORT_DIR=/app/reports

EXPOSE 3000

CMD ["node", "src/server.js"]
