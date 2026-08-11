FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY H5pLms.Api.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app
COPY --from=build /app/publish .
RUN mkdir -p /app/data && chown -R 10001:0 /app
USER 10001
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
ENTRYPOINT ["dotnet", "H5pLms.Api.dll"]
